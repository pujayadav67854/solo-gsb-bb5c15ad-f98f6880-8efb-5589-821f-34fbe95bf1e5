import { useMemo, useState } from 'react';
import { Project } from './types';
import { applyBatch, previewBatch } from './batch';
import { CyclePath } from './SidePanel';

interface BatchPanelProps {
  project: Project;
  onConfirm: (apply: (p: Project) => Project) => void;
  onClose: () => void;
}

const PLACEHOLDER = `# 每行：行号 名称 时长秒 用人数 [前置:等待秒 …]
# 示例：
# 1 幕布落下 3 1
# 2 布景A撤场 8 2 1:1
# 3 布景B上场 10 2 2:2 n-curtain-up:0`;

/**
 * 多行口令批量录入对话框。
 * - 导演粘贴多行清单，按行号给出名称、时长、用人数及前置关系；
 * - 前置可引用本批行号（允许引用后面的行）或现有口令 ID，并注明最少等待秒数；
 * - 实时预览将生成的口令、约束与总工期变化（最早排程 / 班组排程）；
 * - 重复行号、缺失引用、数值非法或合并后成环按行指出原因，整批不写入；
 * - 取消不保存；确认后整批写入当前项目，沿现有编辑链重算排程并持久化。
 */
export function BatchPanel({ project, onConfirm, onClose }: BatchPanelProps) {
  const [text, setText] = useState('');

  const preview = useMemo(() => previewBatch(text, project), [text, project]);
  const { parse } = preview;

  const existingNodeById = new Map(project.nodes.map((n) => [n.id, n]));

  const newEdgeCount = parse.rows.reduce((sum, r) => sum + r.prereqs.length, 0);
  const toExisting = parse.rows.reduce(
    (sum, r) => sum + r.prereqs.filter((p) => !p.isBatchLine).length,
    0,
  );

  const curMakespan = preview.currentSchedule.ok ? preview.currentSchedule.makespan : undefined;
  const newMakespan = preview.mergedSchedule?.ok ? preview.mergedSchedule.makespan : undefined;
  const curCrewMakespan = preview.currentCrew.ok ? preview.currentCrew.makespan : undefined;
  const newCrewMakespan = preview.mergedCrew?.ok ? preview.mergedCrew.makespan : undefined;

  const lineCount = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;

  const confirm = () => {
    if (!parse.ok) return;
    onConfirm((p: Project) => applyBatch(p, parse));
  };

  return (
    <div className="replan-overlay" onPointerDown={onClose}>
      <div className="batch-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>批量录入口令</h3>
        <p className="hint">
          每行一条口令：<code>行号 名称 时长 用人数 [前置:等待秒 …]</code>；字段可用空格或「|」分隔。
          前置填写「引用:最少等待秒数」，引用为<strong>本批行号</strong>（允许引用后面的行）或<strong>现有口令 ID</strong>；
          空行与「#」开头的行忽略。确认前可在下方预览将生成的口令、约束与总工期变化，取消不保存。
        </p>
        <textarea
          className="batch-input"
          autoFocus
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {parse.lineErrors.length > 0 && (
          <div className="batch-errors">
            <p className="batch-errors-title">以下行存在问题，整批不会写入：</p>
            <ul>
              {parse.lineErrors.map((e, i) => (
                <li key={`${e.lineNo}-${i}`}>
                  <span className="batch-error-line">第 {e.lineNo} 行：</span>
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {parse.globalErrors.length > 0 && (
          <div className="batch-errors">
            <ul>
              {parse.globalErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {parse.cycle && parse.mergedProject && (
          <CyclePath project={parse.mergedProject} cycle={parse.cycle} />
        )}

        {lineCount > 0 && parse.ok && parse.rows.length > 0 && (
          <>
            <table className="replan-table batch-table">
              <thead>
                <tr>
                  <th>行号</th>
                  <th>名称</th>
                  <th>时长</th>
                  <th>用人数</th>
                  <th>前置（等待秒数）</th>
                </tr>
              </thead>
              <tbody>
                {[...parse.rows]
                  .sort((a, b) => a.lineNo - b.lineNo)
                  .map((r) => (
                    <tr key={r.nodeId}>
                      <td>{r.lineNo}</td>
                      <td>{r.name}</td>
                      <td>{round1(r.duration)}s</td>
                      <td>{r.crew}</td>
                      <td>
                        {r.prereqs.length === 0
                          ? '—'
                          : r.prereqs
                              .slice()
                              .sort((a, b) =>
                                a.isBatchLine !== b.isBatchLine
                                  ? a.isBatchLine
                                    ? -1
                                    : 1
                                  : a.ref.localeCompare(b.ref),
                              )
                              .map((p) => {
                                  const label = p.isBatchLine
                                    ? `行 ${p.ref}`
                                    : existingNodeById.get(p.predNodeId)?.name ?? p.ref;
                                  return (
                                    <span key={p.edgeId} className="batch-prereq">
                                      {label}
                                      <span className="batch-prereq-wait">+{round1(p.wait)}s</span>
                                    </span>
                                  );
                                })}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="hint">
              将新增 <strong>{parse.rows.length}</strong> 条口令、
              <strong> {newEdgeCount}</strong> 条约束
              {toExisting > 0 && `（其中 ${toExisting} 条连接到现有口令）`}，
              口令 ID 与约束 ID 已在确认前预分配并完成两类前置连接。
            </p>
            <table className="whatif-table batch-makespan">
              <thead>
                <tr>
                  <th>总工期</th>
                  <th>当前</th>
                  <th>合并后</th>
                  <th>变化</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>最早排程</td>
                  <td>{curMakespan === undefined ? '—' : `${round1(curMakespan)}s`}</td>
                  <td>{newMakespan === undefined ? '—' : `${round1(newMakespan)}s`}</td>
                  <td>
                    {curMakespan === undefined || newMakespan === undefined ? (
                      '—'
                    ) : (
                      <Delta value={newMakespan - curMakespan} />
                    )}
                  </td>
                </tr>
                <tr>
                  <td>班组排程（{project.crewSize ?? 1} 人）</td>
                  <td>{curCrewMakespan === undefined ? '—' : `${round1(curCrewMakespan)}s`}</td>
                  <td>{newCrewMakespan === undefined ? '—' : `${round1(newCrewMakespan)}s`}</td>
                  <td>
                    {curCrewMakespan === undefined || newCrewMakespan === undefined ? (
                      '—'
                    ) : (
                      <Delta value={newCrewMakespan - curCrewMakespan} />
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}
        {lineCount === 0 && <p className="hint">请粘贴或输入多行口令清单后查看预览。</p>}

        <div className="replan-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!parse.ok || parse.rows.length === 0} onClick={confirm}>
            确认整批写入（{parse.rows.length} 条）
          </button>
        </div>
        <p className="hint">
          确认后整批写入当前项目并沿现有编辑链重算排程、防抖保存；任一行校验不通过或合并后成环时整批不写入。
        </p>
      </div>
    </div>
  );
}

function Delta({ value }: { value: number }) {
  if (Math.abs(value) < 1e-9) return <span className="delta-zero">不变</span>;
  return (
    <span className={value > 0 ? 'delta-up' : 'delta-down'}>
      {value > 0 ? '+' : '−'}
      {round1(Math.abs(value))}s
    </span>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
