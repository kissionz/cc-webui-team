import { createRequire } from "node:module";

import type { MaxComputeConfig } from "../domain/index.js";
import type { MaxComputeCredentials } from "./maxcompute-client.js";

export interface DataWorksColumnRelation {
  sourceId: string;
  sourceTable: string;
  sourceColumn: string;
  targetId: string;
  targetTable: string;
  targetColumn: string;
  taskId: string | null;
  taskType: string | null;
  createTime: number | null;
}

export interface DataWorksColumnNode {
  id: string;
  table: string;
  column: string;
  depth: number;
  root: boolean;
  boundary: boolean;
}

export interface DataWorksColumnGraph {
  rootId: string;
  depth: number;
  direction: "up" | "down" | "both";
  nodes: DataWorksColumnNode[];
  edges: DataWorksColumnRelation[];
  truncated: boolean;
}

interface DataWorksColumn { id?: string; name?: string }
interface DataWorksLineageEntity { id?: string; name?: string }
interface DataWorksLineageRelationship {
  srcEntity?: DataWorksLineageEntity;
  dstEntity?: DataWorksLineageEntity;
  task?: { id?: string; type?: string };
  createTime?: number;
}
interface DataWorksLineage {
  srcEntity?: DataWorksLineageEntity;
  dstEntity?: DataWorksLineageEntity;
  relationships?: DataWorksLineageRelationship[];
}
interface DataWorksSdk {
  listColumns(request: object): Promise<{ body?: { pagingInfo?: { columns?: DataWorksColumn[] } } }>;
  listLineages(request: object): Promise<{ body?: { pagingInfo?: { lineages?: DataWorksLineage[]; totalCount?: number } } }>;
}

interface DataWorksClientConfig {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  endpoint: string;
  protocol: string;
  connectTimeout: number;
  readTimeout: number;
  type?: string;
}
interface DataWorksClientConstructor { new(config: DataWorksClientConfig): DataWorksSdk }
interface RequestConstructor { new(map: Record<string, unknown>): object }
interface DataWorksRuntime {
  Client: DataWorksClientConstructor;
  ListColumnsRequest: RequestConstructor;
  ListLineagesRequest: RequestConstructor;
}
const require = createRequire(import.meta.url);
let cachedRuntime: DataWorksRuntime | null = null;

function loadDataWorksRuntime(): DataWorksRuntime {
  if (cachedRuntime) return cachedRuntime;
  const sdk = require("@alicloud/dataworks-public20240518") as {
    default: DataWorksClientConstructor;
    ListColumnsRequest: RequestConstructor;
    ListLineagesRequest: RequestConstructor;
  };
  cachedRuntime = { Client: sdk.default, ListColumnsRequest: sdk.ListColumnsRequest, ListLineagesRequest: sdk.ListLineagesRequest };
  return cachedRuntime;
}

export interface DataWorksColumnLineageClientOptions {
  credentials: MaxComputeCredentials;
  region: string;
  client?: DataWorksSdk;
  maximumPages?: number;
}

export class DataWorksColumnLineageClient {
  private readonly client: DataWorksSdk;
  private readonly maximumPages: number;
  private readonly requestModels: Pick<DataWorksRuntime, "ListColumnsRequest" | "ListLineagesRequest"> | null;

  constructor(options: DataWorksColumnLineageClientOptions) {
    this.maximumPages = options.maximumPages ?? 3;
    if (options.client) {
      this.client = options.client;
      this.requestModels = null;
    } else {
      const runtime = loadDataWorksRuntime();
      this.requestModels = runtime;
      this.client = new runtime.Client({
        accessKeyId: options.credentials.accessKeyId,
        accessKeySecret: options.credentials.accessKeySecret,
        regionId: options.region,
        endpoint: `dataworks.${options.region}.aliyuncs.com`,
        protocol: "https",
        connectTimeout: 5_000,
        readTimeout: 10_000,
      });
    }
  }

  async queryColumn(input: { project: string; table: string; column: string }): Promise<DataWorksColumnRelation[]> {
    const selected = await this.resolveColumn(input);
    if (!selected?.id || !selected.name) return [];

    const lineages = [
      ...await this.listDirection({ dstEntityId: selected.id }),
      ...await this.listDirection({ srcEntityId: selected.id }),
    ];
    const relations = new Map<string, DataWorksColumnRelation>();
    for (const lineage of lineages) {
      const outerSource = parseMaxComputeColumn(lineage.srcEntity);
      const outerTarget = parseMaxComputeColumn(lineage.dstEntity);
      for (const relationship of lineage.relationships?.length ? lineage.relationships : [undefined]) {
        const source = parseMaxComputeColumn(relationship?.srcEntity) ?? outerSource;
        const target = parseMaxComputeColumn(relationship?.dstEntity) ?? outerTarget;
        if (!source || !target) continue;
        const relation: DataWorksColumnRelation = {
          sourceId: source.id,
          sourceTable: `${source.project}.${source.table}`,
          sourceColumn: source.column,
          targetId: target.id,
          targetTable: `${target.project}.${target.table}`,
          targetColumn: target.column,
          taskId: relationship?.task?.id ?? null,
          taskType: relationship?.task?.type ?? null,
          createTime: relationship?.createTime ?? null,
        };
        relations.set(relationKey(relation), relation);
      }
    }
    return [...relations.values()];
  }

  async queryColumnGraph(input: {
    project: string;
    table: string;
    column: string;
    depth?: number;
    direction?: "up" | "down" | "both";
    maximumNodes?: number;
  }): Promise<DataWorksColumnGraph> {
    const maximumDepth = Math.max(1, Math.min(5, input.depth ?? 3));
    const maximumNodes = Math.max(20, Math.min(300, input.maximumNodes ?? 180));
    const direction = input.direction ?? "both";
    const selected = await this.resolveColumn(input);
    if (!selected?.id || !selected.name) {
      return { rootId: "", depth: maximumDepth, direction, nodes: [], edges: [], truncated: false };
    }
    const root = parseMaxComputeColumn({ id: selected.id, name: selected.name });
    if (!root) return { rootId: "", depth: maximumDepth, direction, nodes: [], edges: [], truncated: false };

    const nodeDepth = new Map<string, number>([[root.id, 0]]);
    const nodeValues = new Map<string, ReturnType<typeof parseMaxComputeColumn>>([[root.id, root]]);
    const edges = new Map<string, DataWorksColumnRelation>();
    const expanded = new Set<string>();
    let frontier = [root.id];
    let truncated = false;
    for (let currentDepth = 1; currentDepth <= maximumDepth && frontier.length; currentDepth += 1) {
      const next = new Set<string>();
      for (let offset = 0; offset < frontier.length; offset += 6) {
        const batch = frontier.slice(offset, offset + 6).filter((id) => !expanded.has(id));
        const batches = await Promise.all(batch.map(async (id) => ({
          id,
          lineages: [
            ...(direction !== "down" ? await this.listDirection({ dstEntityId: id }) : []),
            ...(direction !== "up" ? await this.listDirection({ srcEntityId: id }) : []),
          ],
        })));
        for (const item of batches) {
          expanded.add(item.id);
          for (const relation of relationsFromLineages(item.lineages)) {
            const neighborId = relation.sourceId === item.id ? relation.targetId : relation.sourceId;
            if (!nodeDepth.has(neighborId)) {
              if (nodeDepth.size >= maximumNodes) { truncated = true; continue; }
              nodeDepth.set(neighborId, currentDepth);
              nodeValues.set(neighborId, parseMaxComputeColumn({ id: neighborId }));
              next.add(neighborId);
            }
            if (nodeDepth.has(relation.sourceId) && nodeDepth.has(relation.targetId)) edges.set(relationKey(relation), relation);
          }
        }
      }
      frontier = [...next];
    }
    const nodes: DataWorksColumnNode[] = [];
    for (const [id, depth] of nodeDepth) {
      const value = nodeValues.get(id);
      if (!value) continue;
      nodes.push({ id, table: `${value.project}.${value.table}`, column: value.column, depth, root: id === root.id, boundary: depth === maximumDepth });
    }
    return { rootId: root.id, depth: maximumDepth, direction, nodes, edges: [...edges.values()], truncated };
  }

  private async resolveColumn(input: { project: string; table: string; column: string }): Promise<DataWorksColumn | undefined> {
    const tableId = `maxcompute-table:::${input.project}::${input.table}`;
    const columns = (await this.client.listColumns(this.columnsRequest({
      tableId, name: input.column, pageNumber: 1, pageSize: 100, sortBy: "Name", order: "Asc",
    }))).body?.pagingInfo?.columns ?? [];
    return columns.find((item) => item.name?.toLocaleLowerCase() === input.column.toLocaleLowerCase());
  }

  private async listDirection(filter: { srcEntityId?: string; dstEntityId?: string }): Promise<DataWorksLineage[]> {
    const output: DataWorksLineage[] = [];
    for (let pageNumber = 1; pageNumber <= this.maximumPages; pageNumber += 1) {
      const response = await this.client.listLineages(this.lineagesRequest({
        ...filter,
        needAttachRelationship: true,
        pageNumber,
        pageSize: 100,
        sortBy: "Name",
        order: "Asc",
      }));
      const paging = response.body?.pagingInfo;
      const rows = paging?.lineages ?? [];
      output.push(...rows);
      if (!rows.length || output.length >= (paging?.totalCount ?? 0)) break;
    }
    return output;
  }

  private columnsRequest(values: Record<string, unknown>): object {
    return this.requestModels ? new this.requestModels.ListColumnsRequest(values) : values;
  }

  private lineagesRequest(values: Record<string, unknown>): object {
    return this.requestModels ? new this.requestModels.ListLineagesRequest(values) : values;
  }
}

export function inferDataWorksRegion(config: MaxComputeConfig, project: string): string | null {
  const discovered = config.discoveredProjects.find((item) => item.name.toLocaleLowerCase() === project.toLocaleLowerCase())?.region;
  if (discovered && /^[a-z]{2}-[a-z0-9-]+$/i.test(discovered)) return discovered.toLocaleLowerCase();
  const match = config.endpoint.match(/(?:^|\.)([a-z]{2}-[a-z0-9-]+)\.maxcompute\./i);
  return match?.[1]?.toLocaleLowerCase() ?? null;
}

export function splitMaxComputeTable(value: string, defaultProject: string): { project: string; table: string } | null {
  const parts = value.split(".").filter(Boolean);
  if (parts.length === 1 && defaultProject) return { project: defaultProject, table: parts[0]! };
  if (parts.length === 2) return { project: parts[0]!, table: parts[1]! };
  return null;
}

function parseMaxComputeColumn(entity: DataWorksLineageEntity | undefined): { id: string; project: string; table: string; column: string } | null {
  if (!entity?.id) return null;
  const parts = entity.id.split(":");
  if (parts[0] !== "maxcompute-column" || parts.length < 7) return null;
  const project = parts[3] ?? "";
  const table = parts.at(-2) ?? "";
  const column = parts.at(-1) ?? "";
  return project && table && column ? { id: entity.id, project, table, column } : null;
}

function relationsFromLineages(lineages: DataWorksLineage[]): DataWorksColumnRelation[] {
  const relations = new Map<string, DataWorksColumnRelation>();
  for (const lineage of lineages) {
    const outerSource = parseMaxComputeColumn(lineage.srcEntity);
    const outerTarget = parseMaxComputeColumn(lineage.dstEntity);
    for (const relationship of lineage.relationships?.length ? lineage.relationships : [undefined]) {
      const source = parseMaxComputeColumn(relationship?.srcEntity) ?? outerSource;
      const target = parseMaxComputeColumn(relationship?.dstEntity) ?? outerTarget;
      if (!source || !target) continue;
      const relation: DataWorksColumnRelation = {
        sourceId: source.id, sourceTable: `${source.project}.${source.table}`, sourceColumn: source.column,
        targetId: target.id, targetTable: `${target.project}.${target.table}`, targetColumn: target.column,
        taskId: relationship?.task?.id ?? null, taskType: relationship?.task?.type ?? null,
        createTime: relationship?.createTime ?? null,
      };
      relations.set(relationKey(relation), relation);
    }
  }
  return [...relations.values()];
}

function relationKey(value: Pick<DataWorksColumnRelation, "sourceTable" | "sourceColumn" | "targetTable" | "targetColumn">): string {
  return [value.sourceTable, value.sourceColumn, value.targetTable, value.targetColumn].map((item) => item.toLocaleLowerCase()).join("\u0000");
}
