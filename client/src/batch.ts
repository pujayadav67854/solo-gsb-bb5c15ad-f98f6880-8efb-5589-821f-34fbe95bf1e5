import {
  CommandEdge,
  CommandNode,
  CycleInfo,
  Project,
  ScheduleResult,
  CrewScheduleResult,
} from './types';
import { computeCrewSchedule, computeSchedule } from './schedule';

/** 单条前置引用（确认前已解析到具体口令节点 ID） */
export interface BatchPrereq {
  /** 原文引用：本批行号（正整数）或现有口令 ID */
  ref: string;
  /** 解析到的前置口令节点 ID */
  predNodeId: string;
  /** 前置是否为本批新口令 */
  isBatchLine: boolean;
  /** 前置完成后至少等待的秒数（有限非负数） */
  wait: number;
  /** 确认时生成的约束边 ID */
  edgeId: string;
}

/** 一条成功解析的口令行（含确认前预分配的 ID 与坐标） */
export interface BatchRow {
  lineNo: number;
  name: string;
  duration: number;
  crew: number;
  prereqs: BatchPrereq[];
  /** 确认前为新口令预分配的 ID（提前分配以便连接后面的行） */
  nodeId: string;
  x: number;
  y: number;
}

export interface BatchLineError {
  /** 原文行号（从 1 开始） */
  lineNo: number;
  /** 原文内容 */
  raw: string;
  message: string;
}

export interface BatchParseResult {
  ok: boolean;
  rows: BatchRow[];
  lineErrors: BatchLineError[];
  /** 非逐行的整体性错误（如仅由现有口令构成的环） */
  globalErrors: string[];
  /** 合并后图成环时的成环信息 */
  cycle?: CycleInfo;
  /** 字段解析通过后合并得到的项目（含成环失败的情形，供预览渲染成环路径） */
  mergedProject?: Project;
}

export interface BatchPreview {
  parse: BatchParseResult;
  /** 合并写入后将得到的项目（仅在 ok 时有意义，不改变入参） */
  mergedProject?: Project;
  /** 当前项目的最早排程 */
  currentSchedule: ScheduleResult;
  /** 合并后的最早排程 */
  mergedSchedule?: ScheduleResult;
  /** 当前项目的班组排程 */
  currentCrew: CrewScheduleResult;
  /** 合并后的班组排程 */
  mergedCrew?: CrewScheduleResult;
}

const DEFAULT_ID_FACTORY: () => string = () => crypto.randomUUID();

/**
 * 解析导演粘贴的多行口令清单。
 *
 * 每行格式（`|` 或空白分隔）：
 *   行号 名称 时长秒 用人数 [前置1:等待秒 前置2:等待秒 …]
 * - 前置引用本批行号（正整数，允许引用后面的行）或现有口令 ID；
 * - 空行与以 # 开头的注释行忽略；
 * - 时长、等待秒数须为有限非负数，用人数须为不超过班组人数的非负整数；
 * - 重复行号、缺失引用、重复前置、合并后成环均按行指出，整批失败。
 *
 * 确认前即为每条新口令与新约束预分配 ID，使引用后面行的前置可正确连接。
 */
export function parseBatch(text: string, project: Project, idFactory: () => string = DEFAULT_ID_FACTORY): BatchParseResult {
  const capacity = normalizedCrewSize(project.crewSize);
  const existingIds = new Set(project.nodes.map((n) => n.id));
  const rawLines = text.split(/\r?\n/);

  // 先按行做字段级解析，记录错误；行号在本阶段收集以做重复 / 缺失引用检查
  const lineErrors: BatchLineError[] = [];
  const parsed: Array<{
    lineNo: number;
    name: string;
    duration: number;
    crew: number;
    prereqTokens: string[];
  }> = [];
  const seenLineNos = new Set<number>();

  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    // | 或竖线分隔时优先按竖线切分，否则按空白切分（兼容半角 / 全角竖线与全角冒号）
    const normalized = trimmed.replace(/[｜]/g, '|').replace(/[：]/g, ':');
    const parts = normalized.includes('|')
      ? normalized.split('|').map((s) => s.trim()).filter((s) => s !== '')
      : normalized.split(/\s+/);

    const fail = (message: string) => lineErrors.push({ lineNo, raw, message });

    if (parts.length < 4) {
      fail(`字段不足：应为「行号 名称 时长 用人数 [前置:等待 …]」，当前仅 ${parts.length} 个字段`);
      return;
    }

    const lineNoStr = parts[0];
    const name = parts[1];
    const durationStr = parts[2];
    const crewStr = parts[3];

    if (!/^\d+$/.test(lineNoStr) || Number(lineNoStr) < 1) {
      fail(`行号「${lineNoStr}」非法：须为正整数`);
      return;
    }
    const lineNoValue = Number(lineNoStr);
    if (seenLineNos.has(lineNoValue)) {
      fail(`行号 ${lineNoValue} 重复`);
      return;
    }

    if (name === '') {
      fail('名称为空');
      return;
    }

    const duration = Number(durationStr);
    if (durationStr.trim() === '' || !Number.isFinite(duration) || duration < 0) {
      fail(`时长「${durationStr}」非法：须为有限非负数字`);
      return;
    }

    const crew = Number(crewStr);
    if (crewStr.trim() === '' || !Number.isInteger(crew) || crew < 0) {
      fail(`用人数「${crewStr}」非法：须为非负整数`);
      return;
    }
    if (crew > capacity) {
      fail(`用人数 ${crew} 超过班组人数 ${capacity}`);
      return;
    }

    seenLineNos.add(lineNoValue);
    parsed.push({
      lineNo: lineNoValue,
      name,
      duration,
      crew,
      prereqTokens: parts.slice(4),
    });
  });

  // 字段级有错即整批失败（后续引用解析依赖完整行号表）
  if (lineErrors.length > 0) {
    return { ok: false, rows: [], lineErrors: sortErrors(lineErrors), globalErrors: [] };
  }

  // 预分配口令 ID，建立行号 → 行的映射
  const rows: BatchRow[] = parsed.map((p) => ({
    lineNo: p.lineNo,
    name: p.name,
    duration: p.duration,
    crew: p.crew,
    prereqs: [],
    nodeId: idFactory(),
    x: 0,
    y: 0,
  }));
  const rowByLineNo = new Map(rows.map((r) => [r.lineNo, r]));
  const rowByNodeId = new Map(rows.map((r) => [r.nodeId, r]));

  // 解析前置引用（此时允许引用本批中后面的行）
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const row = rows[i];
    const seenRefs = new Set<string>();
    for (const token of p.prereqTokens) {
      const fail = (message: string) => lineErrors.push({ lineNo: row.lineNo, raw: rawLines[row.lineNo - 1], message });

      const colonIdx = token.lastIndexOf(':');
      if (colonIdx < 0) {
        fail(`前置「${token}」格式非法：应为「引用:等待秒数」`);
        continue;
      }
      const ref = token.slice(0, colonIdx).trim();
      const waitStr = token.slice(colonIdx + 1).trim();
      if (ref === '') {
        fail(`前置「${token}」缺少引用：应为「行号或口令ID:等待秒数」`);
        continue;
      }
      const wait = Number(waitStr);
      if (waitStr === '' || !Number.isFinite(wait) || wait < 0) {
        fail(`前置「${token}」的等待秒数「${waitStr}」非法：须为有限非负数字`);
        continue;
      }
      if (seenRefs.has(ref)) {
        fail(`前置引用「${ref}」重复`);
        continue;
      }
      seenRefs.add(ref);

      let predNodeId: string;
      let isBatchLine: boolean;
      if (/^\d+$/.test(ref)) {
        const refLine = Number(ref);
        const target = rowByLineNo.get(refLine);
        if (!target) {
          fail(`前置引用行号 ${ref} 缺失：本批清单中没有该行号`);
          continue;
        }
        if (target.lineNo === row.lineNo) {
          fail(`前置不能引用自身（行号 ${ref}）`);
          continue;
        }
        predNodeId = target.nodeId;
        isBatchLine = true;
      } else {
        if (!existingIds.has(ref)) {
          fail(`前置引用口令 ID「${ref}」缺失：当前项目中没有该口令`);
          continue;
        }
        predNodeId = ref;
        isBatchLine = false;
      }

      row.prereqs.push({ ref, predNodeId, isBatchLine, wait, edgeId: idFactory() });
    }
  }

  if (lineErrors.length > 0) {
    return { ok: false, rows: [], lineErrors: sortErrors(lineErrors), globalErrors: [] };
  }

  // 计算新口令坐标：按本批前置链最长层级分列，起点接在现有节点右侧
  layoutRows(rows, project);

  // 合并到项目副本后做环检测与排程
  const mergedProject = mergeIntoProject(project, rows);
  const mergedSchedule = computeSchedule(mergedProject);
  if (mergedSchedule.ok) {
    return { ok: true, rows, lineErrors: [], globalErrors: [], mergedProject };
  }
  if (!mergedSchedule.cycle) {
    // 理论上不会发生（无 cycle 信息的失败），保守按整批失败处理
    return {
      ok: false,
      rows: [],
      lineErrors: [],
      globalErrors: ['合并后的口令图无法排程，请检查前置约束。'],
      mergedProject,
    };
  }

  // 成环：环上若含本批新口令，逐行指出；仅含现有口令则给整体错误
  const cycle = mergedSchedule.cycle;
  const cycleRows = cycle.nodeIds
    .map((id) => rowByNodeId.get(id)?.lineNo)
    .filter((n): n is number => n !== undefined);
  if (cycleRows.length > 0) {
    const pathText = formatCyclePath(mergedProject, cycle);
    for (const lineNo of [...cycleRows].sort((a, b) => a - b)) {
      lineErrors.push({
        lineNo,
        raw: rawLines[lineNo - 1],
        message: `该口令位于成环路径上：${pathText}`,
      });
    }
  } else {
    return {
      ok: false,
      rows: [],
      lineErrors: [],
      globalErrors: [`合并后的口令图存在环依赖（环路由现有口令构成）：${formatCyclePath(mergedProject, cycle)}`],
      cycle,
      mergedProject,
    };
  }
  return { ok: false, rows: [], lineErrors: sortErrors(lineErrors), globalErrors: [], cycle, mergedProject };
}

/** 预览：解析并计算合并前后的最早排程与班组排程及总工期变化（纯内存，不写入）。 */
export function previewBatch(text: string, project: Project, idFactory?: () => string): BatchPreview {
  const currentSchedule = computeSchedule(project);
  const currentCrew = computeCrewSchedule(project);
  const parse = parseBatch(text, project, idFactory);
  if (!parse.ok || !parse.mergedProject) {
    return { parse, mergedProject: parse.mergedProject, currentSchedule, currentCrew };
  }
  return {
    parse,
    mergedProject: parse.mergedProject,
    currentSchedule,
    mergedSchedule: computeSchedule(parse.mergedProject),
    currentCrew,
    mergedCrew: computeCrewSchedule(parse.mergedProject),
  };
}

/**
 * 确认写入：把预览结果中的新口令与约束整批加入当前项目。
 * 仅接受 parseBatch 成功的结果；调用后沿现有编辑链重算排程并防抖持久化。
 */
export function applyBatch(project: Project, parse: BatchParseResult): Project {
  if (!parse.ok) return project;
  return mergeIntoProject(project, parse.rows);
}

/** 收集将新增的节点与边（供预览计数）。 */
export function batchElements(rows: BatchRow[]): { nodes: CommandNode[]; edges: CommandEdge[] } {
  const nodes: CommandNode[] = rows.map((r) => ({
    id: r.nodeId,
    name: r.name,
    duration: r.duration,
    crew: r.crew,
    x: r.x,
    y: r.y,
  }));
  const edges: CommandEdge[] = [];
  for (const r of rows) {
    for (const p of r.prereqs) {
      edges.push({ id: p.edgeId, from: p.predNodeId, to: r.nodeId, minDelay: p.wait });
    }
  }
  return { nodes, edges };
}

function mergeIntoProject(project: Project, rows: BatchRow[]): Project {
  const { nodes, edges } = batchElements(rows);
  return {
    ...project,
    nodes: [...project.nodes, ...nodes],
    edges: [...project.edges, ...edges],
  };
}

/**
 * 新口令布局：层级 = 本批前置链的最长层数 + 1（引用现有口令的前置不抬高本批层级）；
 * 同层按行号纵向排列；整块放在现有节点包围盒右侧，避免与原图重叠。
 */
function layoutRows(rows: BatchRow[], project: Project): void {
  const batchNodeIds = new Set(rows.map((r) => r.nodeId));
  const levelOf = new Map<string, number>();
  const computeLevel = (visiting: Set<string>, id: string): number => {
    const cached = levelOf.get(id);
    if (cached !== undefined) return cached;
    // parseBatch 已保证无环（含自引用），递归必然收敛
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const row = rows.find((r) => r.nodeId === id)!;
    let level = 0;
    for (const p of row.prereqs) {
      if (batchNodeIds.has(p.predNodeId)) {
        level = Math.max(level, computeLevel(visiting, p.predNodeId) + 1);
      }
    }
    visiting.delete(id);
    levelOf.set(id, level);
    return level;
  };

  for (const row of rows) computeLevel(new Set(), row.nodeId);

  const perLevel = new Map<number, BatchRow[]>();
  for (const row of rows) {
    const level = levelOf.get(row.nodeId) ?? 0;
    if (!perLevel.has(level)) perLevel.set(level, []);
    perLevel.get(level)!.push(row);
  }

  const COL_W = 220;
  const ROW_H = 96;
  const X0 = 80;
  const Y0 = 80;
  let baseX = X0;
  if (project.nodes.length > 0) {
    const maxX = Math.max(...project.nodes.map((n) => n.x));
    baseX = Math.max(X0, maxX + 200);
  }
  for (const [level, list] of [...perLevel.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.lineNo - b.lineNo);
    list.forEach((row, i) => {
      row.x = baseX + level * COL_W;
      row.y = Y0 + i * ROW_H;
    });
  }
}

function formatCyclePath(project: Project, cycle: CycleInfo): string {
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  const edgeSet = new Set(cycle.edgeIds);
  const chain: string[] = [];
  const start = cycle.nodeIds[0];
  if (start) {
    chain.push(nodeById.get(start)?.name ?? start);
    let cur = start;
    for (let i = 0; i < cycle.edgeIds.length; i++) {
      const e = project.edges.find((ed) => edgeSet.has(ed.id) && ed.from === cur);
      if (!e) break;
      chain.push(nodeById.get(e.to)?.name ?? e.to);
      cur = e.to;
    }
  }
  return chain.join(' → ');
}

function sortErrors(errors: BatchLineError[]): BatchLineError[] {
  return errors.sort((a, b) => (a.lineNo !== b.lineNo ? a.lineNo - b.lineNo : a.message.localeCompare(b.message)));
}

function normalizedCrewSize(v: number | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}
