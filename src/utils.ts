/*
 *
 * Copyright (c) 2019 Jan Pieter Posthuma / DataScenarios
 *
 * All rights reserved.
 *
 * MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 */

"use strict";
import powerbi from "powerbi-visuals-api";
import { IFilterTarget, IFilterColumnTarget, Selector } from "powerbi-models";
import { valueFormatter } from "powerbi-visuals-utils-formattingutils";
import { valueType } from "powerbi-visuals-utils-typeutils";
import { Selection } from "d3-selection";
import { isArray } from "lodash-es";

import { HierarchySlicerProperties, IHierarchySlicerDataPoint } from "./interfaces";

import IFilter = powerbi.IFilter;
import FilterAction = powerbi.FilterAction;
import DataViewMetadata = powerbi.DataViewMetadata;
import ValueTypeDescriptor = powerbi.ValueTypeDescriptor;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import VisualObjectInstance = powerbi.VisualObjectInstance;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ValueType = valueType.ValueType;
import ValueFormat = valueFormatter.format;

enum SQExprKind {
    ColumnRef = 2,
    Hierarchy = 6,
    HierarchyLevel = 7,
}

export function parseFilter(
    jsonFilters: IFilter[] | undefined,
    columnFilters: IFilterTarget[],
    metadata: DataViewMetadata,
    filterValues: string | undefined
): string[][] {
    if (jsonFilters) {
        if (jsonFilters.length > 0) {
            if (!(columnFilters[0] as any).hierarchyLevel) {
                const jFilter = jsonFilters[0] as any;
                return jFilter.values.map((filter: any) => {
                    if (isArray(filter)) {
                        return filter.map((v: any, i) => {
                            const {
                                dataType,
                                format,
                            }: { dataType: powerbi.ValueTypeDescriptor; format: string } = getDataTypeAndFormat(
                                metadata,
                                i
                            );
                            return ValueFormat(convertRawValue(v.value, dataType), format);
                        });
                    } else {
                        const {
                            dataType,
                            format,
                        }: { dataType: powerbi.ValueTypeDescriptor; format: string } = getDataTypeAndFormat(
                            metadata,
                            0
                        );
                        return [ValueFormat(convertRawValue(filter, dataType), format)];
                    }
                });
            } else {
                // fallback scenario due to missing info in jsonFilter
                const filter: any = metadata.objects && metadata.objects.general && metadata.objects.general.filter;
                if (filter && filter.whereItems && filter.whereItems[0] && filter.whereItems[0].condition) {
                    let columns = getHierarchyColumns(metadata);
                    // convert advanced filter conditions list to HierarchySlicer selected values format
                    return convertAdvancedFilterConditionsToSlicerData(filter.whereItems[0].condition, columns);
                }
            }
        } else if (filterValues && filterValues !== "") {
            // Legacy version
            return filterValues.split(",").map(filterValue => parseOldOwnId(filterValue));
        }
    }
    return [];
}

function getDataTypeAndFormat(metadata: powerbi.DataViewMetadata, level: number) {
    const nodeMetadata = metadata.columns[level];
    const format: string = nodeMetadata.format || "g";
    const dataType: ValueTypeDescriptor =
        nodeMetadata.type || ValueType.fromDescriptor(<valueType.IValueTypeDescriptor>{ text: true });
    return { dataType, format };
}

export function getHierarchyColumns(
    metadata: powerbi.DataViewMetadata,
    levels: powerbi.DataViewHierarchyLevel[] = []
): powerbi.DataViewMetadataColumn[] {
    const columnMetadata = metadata.columns.filter((c: DataViewMetadataColumn) =>
        c.roles ? c.roles["Fields"] : false
    );
    if (levels.length === 0) {
        return columnMetadata;
    } else {
        return levels.map(level => level.sources[0]);
    }
}

export function parseExpand(expand: string): string[][] {
    if (expand === "") return [];
    const expanded: string[] = expand.split(",");
    return expanded.map(e => parseOwnId(e));
}

export function parseOwnId(ownId: string): string[] {
    if (ownId.endsWith("~|")) {
        return parseNewOwnId(ownId);
    } else {
        return parseOldOwnId(ownId);
    }
}

export function parseNewOwnId(ownId: string): string[] {
    return ownId.substr(2, ownId.length - 4).split("~|~");
}

export function parseOldOwnId(ownId: string): string[] {
    const parts: string[] = ownId.substr(2).split("_|~");
    return parts.map(part => part.split("-")[0]);
}

export function wildcardFilter(value: string, rule: string) {
    return new RegExp("^" + rule.split("*").join(".*") + "$").test(value);
}

export function extractFilterColumnTarget(
    categoryColumn: DataViewCategoryColumn | DataViewMetadataColumn
): IFilterTarget {
    // take an expression from source or column metadata
    let expr: any =
        categoryColumn && (<any>categoryColumn).source && (<any>categoryColumn).source.expr
            ? ((<any>categoryColumn).source.expr as any)
            : ((<any>categoryColumn).expr as any);

    // take table name from source.entity if column definition is simple
    let filterTargetTable: string = expr && expr.source && expr.source.entity ? expr.source.entity : null;

    // take expr.ref as column name if column definition is simple
    let filterTargetColumn: string = expr && expr.ref ? expr.ref : null;

    // special cases
    // when data structure is hierarchical
    if (expr && expr.kind === SQExprKind.HierarchyLevel) {
        let hierarchy: string = expr.arg.hierarchy;
        filterTargetColumn = expr.level;
        let hierarchyLevel: string = expr.level;

        // Only if we have hierarchical structure with virtual table, take table name from identityExprs
        // Power BI creates hierarchy for date type of data (Year, Quater, Month, Days)
        // For it, Power BI creates a virtual table and gives it generated name as... 'LocalDateTable_bcfa94c1-7c12-4317-9a5f-204f8a9724ca'
        // Visuals have to use a virtual table name as a target of JSON to filter date hierarchy properly
        filterTargetTable = expr.arg && expr.arg.arg && expr.arg.arg.entity;
        if (expr.arg && expr.arg.kind === SQExprKind.Hierarchy) {
            if ((<any>categoryColumn).identityExprs && (<any>categoryColumn).identityExprs.length) {
                const identityExprs = (<any>categoryColumn).identityExprs[
                    (<any>categoryColumn).identityExprs.length - 1
                ] as any;
                filterTargetTable = identityExprs.source.entity;
            }
        } else {
            // otherwise take column name from expr
            filterTargetTable = expr.arg && expr.arg.arg && expr.arg.arg.entity;
        }

        return {
            table: filterTargetTable,
            hierarchy: hierarchy,
            hierarchyLevel: hierarchyLevel,
            column: filterTargetColumn,
        };
    }

    return {
        table: filterTargetTable,
        column: filterTargetColumn,
    };
}

export function convertRawValue(
    rawValue: string | number | boolean | Date | undefined,
    dataType: ValueTypeDescriptor,
    full: boolean = false
): any {
    if (dataType.dateTime && full) {
        return new Date(rawValue as Date);
    } else if (dataType.numeric) {
        return rawValue as number;
    } else {
        return rawValue as string;
    }
}

export function convertAdvancedFilterConditionsToSlicerData(
    conditions: any,
    columnDefs: DataViewMetadataColumn[]
): string[][] {
    if (!conditions || !conditions.values || !conditions.args || !columnDefs) {
        return [];
    }

    let result: string[][] = [];

    const args = conditions.args;
    conditions.values.forEach((valueArray: any) => {
        let res: any[] = [];
        valueArray.forEach((value: any, index: number) => {
            if (value.value === null) {
                result.push([""]);
            }
            const columnIndex = columnDefs.findIndex(def => {
                const expr = def.expr as any;
                const arg = args[index];
                const exprColumnName = expr.level ? expr.level : expr.ref;
                const argColumnName = arg.level ? arg.level : arg.ref;

                const exprTableName = expr.source ? expr.source.entity : expr.arg.hierarchy;
                const argTableName = arg.source ? arg.source.entity : arg.arg.hierarchy;
                return exprColumnName === argColumnName && exprTableName === argTableName;
            });
            if (columnIndex !== -1) {
                const format = columnDefs[columnIndex].format || "g";
                const dataType: ValueTypeDescriptor =
                    (columnDefs[columnIndex] && columnDefs[columnIndex].type) ||
                    ValueType.fromDescriptor({ text: true });
                const labelValue = ValueFormat(convertRawValue(value.value, dataType), format);
                res.push({
                    index: columnIndex,
                    value: labelValue.replace(/,/g, ""),
                });
            }
        });

        const r = res.sort((r1, r2) => r1.index - r2.index).map(r => r.value);

        result.push(r);
    });
    return result;
}

export function checkMobile(userAgent: string): boolean {
    return userAgent.indexOf("PBIMobile") !== -1;
}

export function getCommonLevel(selectionDataPoints: IHierarchySlicerDataPoint[]): number {
    return selectionDataPoints.filter(d => d.partialSelected).reduce((s, d) => Math.max(d.level, s), -1) + 1;
}

export function applyFilter(
    hostServices: IVisualHost,
    tree: IHierarchySlicerDataPoint[],
    columnFilters: IFilterTarget[],
    levels: number
): any {
    // Called without data
    if (tree.length === 0) {
        return;
    }

    const targets: IFilterTarget[] = columnFilters.slice(0, levels + 1);
    const dataPoints = tree.filter(d => d.ownId !== ["selectAll"]);
    const filterDataPoints: IHierarchySlicerDataPoint[] = dataPoints.filter(d => d.selected && d.level === levels);

    // create table from tree
    let filterValues: any[] = filterDataPoints.map((dataPoint: IHierarchySlicerDataPoint) => {
        // TupleValueType
        return dataPoint.value.map(value => {
            return <any>{
                // ITupleElementValue
                value,
            };
        });
    });

    let filterInstance: any = {
        $schema: "http://powerbi.com/product/schema#tuple", // tslint:disable-line: no-http-string
        target: targets,
        filterType: 6,
        operator: "In",
        values: filterValues,
    };

    if (!filterValues.length || !filterValues.length) {
        persistFilter(hostServices, [], 1);
        return;
    }

    persistFilter(hostServices, filterInstance);

    return filterInstance;
}

export function persistFilter(
    hostServices: IVisualHost,
    filter: IFilter | IFilter[],
    action: FilterAction = FilterAction.merge
) {
    // make sure that the old method of storing the filter is deleted
    const instance: VisualObjectInstance = {
        objectName: "general",
        selector: Selector,
        properties: {
            filterValues: "",
        },
    };
    hostServices.persistProperties({ remove: [instance] });
    hostServices.applyJsonFilter(
        filter,
        HierarchySlicerProperties.filterPropertyIdentifier.objectName,
        HierarchySlicerProperties.filterPropertyIdentifier.propertyName,
        action
    );
}
