// store 层集成测试：基准回填、合并导入、撤销恢复（不依赖 DOM，只打桩 localStorage）
import './test-dom-stub.ts';
import { useStudioStore } from '../src/stores/studioStore.ts';
import { createProjectBundle } from '../src/utils/projectMerge.ts';
import type { AudioClip, AudioProject, AudioTrack } from '../src/types/audio.ts';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`✗ ${message}`);
  }
}

function makeClip(id: string, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id, assetId: 'synth-drums', name: id, start: 0, duration: 4, offset: 0,
    fadeIn: 0, fadeOut: 0, effect: 'none', effectAmount: 0, ...patch,
  };
}
function makeTrack(id: string, clips: AudioClip[] = []): AudioTrack {
  return { id, name: id, color: '#2563eb', volume: 0.8, pan: 0, muted: false, solo: false, height: 112, clips };
}
function makeProject(tracks: AudioTrack[], assets: AudioProject['assets'] = []): AudioProject {
  return {
    version: 1, name: 'P', bpm: 120, snap: 0.25, loopEnabled: false, loopStart: 0,
    loopEnd: 8, pixelsPerSecond: 92, tracks, assets, updatedAt: 0,
  };
}

// 1. 初始状态：project 与 baseProject 都存在
{
  const state = useStudioStore.getState();
  assert(state.project.tracks.length === 3, '初始工程有 3 条轨道');
  assert(!!state.baseProject, '初始基准存在');
  assert(state.lastImportSnapshot === null, '初始无撤销快照');
}

// 2. 用一个"共同基准"开始：base 两条轨道，本机给 c1 改名，对方删了 c2 并改 c1 的位置
{
  const base = makeProject([makeTrack('t1', [makeClip('c1'), makeClip('c2')])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { name: '本机改名' }), makeClip('c2')])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 6 })])]);

  // 强行把本机状态与基准装到 store（模拟同事分叉点）
  useStudioStore.setState({ project: local, baseProject: base });

  const report = useStudioStore.getState().mergeImportProject(incoming, base, false);

  const merged = useStudioStore.getState().project;
  const clips = merged.tracks[0].clips;
  // c1：两边都改 -> 两份；c2：对方删 -> 删除优先不复活
  assert(clips.length === 2, `合并后 c1 两份、c2 删除，应剩 2 条，实际 ${clips.length}`);
  assert(clips.every((c) => c.id === 'c1' || c.name.includes('对方版本')), '只保留 c1 两个版本');
  assert(clips.every((c) => c.conflict?.kind === 'clip-both-edited'), '两份都标冲突');
  assert(report.clipConflicts === 1, '报告 1 处片段冲突');
  assert(useStudioStore.getState().lastImportSnapshot !== null, '导入后有撤销快照');
}

// 3. 撤销 -> 完整回到导入前（工程、基准、选择）
{
  const before = useStudioStore.getState().lastImportSnapshot;
  assert(before !== null, '前置：撤销快照存在');
  const ok = useStudioStore.getState().undoLastImport();
  assert(ok, '撤销返回 true');
  const state = useStudioStore.getState();
  const clips = state.project.tracks[0].clips;
  assert(clips.length === 2, '撤销后 c2 回来（共 2 条）');
  assert(clips.find((c) => c.id === 'c1')?.name === '本机改名', '撤销后恢复本机改名');
  assert(clips.some((c) => c.id === 'c2'), '撤销后被对方删除的 c2 恢复');
  assert(!clips.some((c) => c.name.includes('对方版本')), '撤销后对方版本消失');
  assert(state.lastImportSnapshot === null, '撤销后清空快照，不能再撤');
  assert(state.baseProject.tracks[0].clips.length === 2, '撤销后基准也回退');
}

// 4. 无快照时撤销安全返回 false
{
  assert(useStudioStore.getState().undoLastImport() === false, '无快照撤销返回 false');
}

// 5. 解决冲突：清掉片段标记
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 1 })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 2 })])]);
  useStudioStore.getState().mergeImportProject(incoming, base, false);
  const clips = useStudioStore.getState().project.tracks[0].clips;
  useStudioStore.getState().resolveClipConflict('t1', clips[0].id);
  const after = useStudioStore.getState().project.tracks[0].clips;
  assert(!after[0].conflict, '确认后清掉片段冲突标记');
}

// 6. 旧版 v1（无 base）合并：报告 legacyBase=true，且以文件本体为基准
{
  // 旧文件内容就是分叉时双方的共同状态
  const forkPoint = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { name: '本机改名' })])]);
  useStudioStore.setState({ project: local, baseProject: forkPoint });
  const oldFile = forkPoint; // 旧文件：同事当时导出的版本，未带基准
  const report = useStudioStore.getState().mergeImportProject(oldFile, oldFile, true);
  assert(report.legacyBase === true, '旧版导入标记 legacyBase');
  // 回填 base == 旧文件 == 分叉点：对方无改动，本机改名被保留，且不产生冲突
  const clips = useStudioStore.getState().project.tracks[0].clips;
  assert(clips.length === 1 && clips[0].name === '本机改名', '旧版回填基准后，本机单边修改正常保留');
  assert(report.clipConflicts === 0, '旧版回填后不应误报冲突');
  useStudioStore.getState().undoLastImport();
}

// 7. v2 包往返：导出的 bundle 可再导入
{
  const state = useStudioStore.getState();
  const bundle = createProjectBundle(state.project, state.baseProject);
  assert(bundle.bundleVersion === 2 && bundle.kind === 'waveforge-project', '导出 v2 包');
  assert(bundle.project.tracks.every((t) => t.clips.every((c) => !c.conflict)), '导出包不带冲突标记');
  assert(!!bundle.base, '导出包内含基准');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
