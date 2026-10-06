import { mergeProjects, parseImportFile, createProjectBundle } from '../src/utils/projectMerge.ts';
import type { AudioProject, AudioClip, AudioTrack } from '../src/types/audio.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`✗ ${message}`);
  }
}

function makeClip(id: string, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    assetId: 'synth-drums',
    name: id,
    start: 0,
    duration: 4,
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    effect: 'none',
    effectAmount: 0,
    ...patch,
  };
}

function makeTrack(id: string, clips: AudioClip[] = [], patch: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id,
    name: id,
    color: '#2563eb',
    volume: 0.8,
    pan: 0,
    muted: false,
    solo: false,
    height: 112,
    clips,
    ...patch,
  };
}

function makeProject(tracks: AudioTrack[], assets: AudioProject['assets'] = []): AudioProject {
  return {
    version: 1,
    name: 'P',
    bpm: 120,
    snap: 0.25,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,
    pixelsPerSecond: 92,
    tracks,
    assets,
    updatedAt: 0,
  };
}

function customAsset(id: string, dataUrl = 'data:audio/wav;base64,AAAA', extra = {}) {
  return { id, name: id, source: 'imported' as const, duration: 4, mimeType: 'audio/wav', dataUrl, ...extra };
}

// 场景 1：只有本机改片段 -> 采用本机
{
  const base = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 2 })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const clip = project.tracks[0].clips[0];
  assert(clip.start === 2, '场景1: 只有本机改应采用本机');
  assert(report.clipConflicts === 0 && report.trackConflicts === 0, '场景1: 不应有冲突');
}

// 场景 2：只有对方改片段 -> 采用对方
{
  const base = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 5 })])]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips[0].start === 5, '场景2: 只有对方改应采用对方');
}

// 场景 3：两边都改片段 -> 两份都保留，均标冲突
{
  const base = makeProject([makeTrack('t1', [makeClip('c1', { start: 0, name: '鼓' })])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 1, name: '鼓' })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 0, name: '鼓改' })])]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const clips = project.tracks[0].clips;
  assert(clips.length === 2, `场景3: 应保留两份，实际 ${clips.length}`);
  assert(clips.every((c) => c.conflict?.kind === 'clip-both-edited'), '场景3: 两份都标冲突');
  assert(clips.some((c) => c.name.includes('对方版本')), '场景3: 对方版本有名称后缀');
  assert(new Set(clips.map((c) => c.id)).size === 2, '场景3: 两份 id 不同');
  assert(report.clipConflicts === 1, '场景3: 报告计数为 1');
}

// 场景 4：对方删除片段，本机没动 -> 不回来
{
  const base = makeProject([makeTrack('t1', [makeClip('c1'), makeClip('c2')])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1'), makeClip('c2')])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips.length === 1, '场景4: 对方删的片段不应回来');
  assert(project.tracks[0].clips[0].id === 'c1', '场景4: 保留未删片段');
}

// 场景 5：对方删除片段，本机改过 -> 删除优先，计入删改冲突
{
  const base = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 3 })])]);
  const incoming = makeProject([makeTrack('t1', [])]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips.length === 0, '场景5: 一边删一边改仍按删除优先');
  assert(report.deleteModifyConflicts === 1, '场景5: 删改冲突计数为 1');
}

// 场景 6：本机删片段 -> 不回来（即使对方没动）
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const local = makeProject([makeTrack('t1', [])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips.length === 0, '场景6: 本机删过的片段不应回来');
}

// 场景 7：各自新增片段 -> 都在
{
  const base = makeProject([makeTrack('t1', [])]);
  const local = makeProject([makeTrack('t1', [makeClip('local-c')])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('incoming-c')])]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  const ids = project.tracks[0].clips.map((c) => c.id).sort();
  assert(ids[0] === 'incoming-c' && ids[1] === 'local-c', '场景7: 双方新增片段都保留');
}

// 场景 8：各自新增轨道 -> 都在
{
  const base = makeProject([]);
  const local = makeProject([makeTrack('lt')]);
  const incoming = makeProject([makeTrack('it')]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  const ids = project.tracks.map((t) => t.id);
  assert(ids.includes('lt') && ids.includes('it'), '场景8: 双方新增轨道都保留');
}

// 场景 9：轨道参数两边改不同字段 -> 字段级合并
{
  const base = makeProject([makeTrack('t1', [], { volume: 0.5, name: '原' })]);
  const local = makeProject([makeTrack('t1', [], { volume: 0.9, name: '原' })]);
  const incoming = makeProject([makeTrack('t1', [], { volume: 0.5, name: '新名' })]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const t = project.tracks[0];
  assert(t.volume === 0.9 && t.name === '新名', '场景9: 不同字段两边改动应字段级合并');
  assert(!t.trackConflicts, '场景9: 不同字段不应报轨道冲突');
  assert(report.trackConflicts === 0, '场景9: 轨道冲突计数应为 0');
}

// 场景 10：轨道参数两边改同一字段 -> 取本机，标轨道冲突并传播到片段
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')], { volume: 0.5 })]);
  const local = makeProject([makeTrack('t1', [makeClip('c1')], { volume: 0.9 })]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1')], { volume: 0.2 })]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const t = project.tracks[0];
  assert(t.volume === 0.9, '场景10: 同字段两边改应保留本机值');
  assert(t.trackConflicts?.length === 1, '场景10: 应标记冲突字段');
  assert(t.clips[0].conflict?.kind === 'track-both-edited', '场景10: 冲突应传播到片段');
  assert(report.trackConflicts === 1, '场景10: 报告轨道冲突 1 处');
}

// 场景 11：对方删轨，本机没动 -> 轨没了，片段也不回来
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')]), makeTrack('t2')]);
  const local = makeProject([makeTrack('t1', [makeClip('c1')]), makeTrack('t2')]);
  const incoming = makeProject([makeTrack('t2')]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks.length === 1 && project.tracks[0].id === 't2', '场景11: 对方删的轨不应回来');
}

// 场景 12：对方删轨、本机改过该轨 -> 不复活，计删改冲突
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')], { name: '原' })]);
  const local = makeProject([makeTrack('t1', [makeClip('c1')], { name: '本机改名' })]);
  const incoming = makeProject([]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks.length === 1 && project.tracks[0].id.startsWith('track-merge'), '场景12: 全删光时兜底轨存在但被删轨不复活');
  assert(project.tracks[0].clips.length === 0, '场景12: 被删轨的片段不应复活');
  assert(report.deleteModifyConflicts === 1, '场景12: 删改冲突 1 处');
}

// 场景 13：跨轨移动，只有一边动 -> 采用移动后的归属
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')]), makeTrack('t2', [])]);
  const local = makeProject([makeTrack('t1', []), makeTrack('t2', [makeClip('c1')])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1')]), makeTrack('t2', [])]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  const t1 = project.tracks.find((t) => t.id === 't1');
  const t2 = project.tracks.find((t) => t.id === 't2');
  assert(t1?.clips.length === 0 && t2?.clips.length === 1, '场景13: 单边移动应被采用');
}

// 场景 14：片段移到新轨，对方删了原轨 -> 片段留在新轨
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')]), makeTrack('t2', [])]);
  const local = makeProject([makeTrack('t1', []), makeTrack('t2', [makeClip('c1')])]);
  const incoming = makeProject([makeTrack('t2', [])]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const t2 = project.tracks.find((t) => t.id === 't2');
  assert(t2?.clips.length === 1, '场景14: 移走后原轨被删，片段应保留');
  assert(t2?.clips[0].conflict?.kind === 'moved-away-deleted', '场景14: 应标 moved-away-deleted');
  assert(report.moveDeleteConflicts === 1 && report.clipConflicts === 0, '场景14: 计入移动/删除冲突而非片段双方编辑');
}

// 场景 15：对方素材补进素材库
{
  const asset = customAsset('a1');
  const base = makeProject([makeTrack('t1', [])]);
  const local = makeProject([makeTrack('t1', [])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { assetId: 'a1' })])], [asset]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.assets.some((a) => a.id === 'a1'), '场景15: 对方素材应进入素材库');
  assert(project.tracks[0].clips[0].assetId === 'a1', '场景15: 片段引用正确');
  assert(report.addedAssets === 1, '场景15: 补入素材计数 1');
}

// 场景 16：同 id 不同内容素材 -> 对方素材换 id，只重映射对方片段
{
  const localAsset = customAsset('a1', 'data:audio/wav;base64,LOCAL');
  const incomingAsset = customAsset('a1', 'data:audio/wav;base64,INCOMING');
  const base = makeProject(
    [makeTrack('t1', [makeClip('lc', { assetId: 'a1' })])],
    [localAsset],
  );
  const local = makeProject(
    [makeTrack('t1', [makeClip('lc', { assetId: 'a1', start: 1 })])],
    [localAsset],
  );
  const incoming = makeProject(
    [makeTrack('t1', [makeClip('lc', { assetId: 'a1', start: 2 })])],
    [incomingAsset],
  );
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  const assets = project.assets.filter((a) => a.dataUrl?.includes('INCOMING'));
  assert(assets.length === 1, '场景16: 对方素材应以新 id 存在');
  assert(assets[0].id !== 'a1', '场景16: 对方素材换了新 id');
  const clips = project.tracks[0].clips;
  const localClip = clips.find((c) => c.id === 'lc');
  const incomingClip = clips.find((c) => c.name.includes('对方版本'));
  assert(localClip?.assetId === 'a1', '场景16: 本机片段仍引用本机素材');
  assert(incomingClip?.assetId === assets[0].id, '场景16: 对方片段重映射到新素材');
}

// 场景 17：素材双方都没带 -> 占位素材，不空片段
{
  const base = makeProject([makeTrack('t1', [])]);
  const local = makeProject([makeTrack('t1', [])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { assetId: 'ghost' })])], []);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  const clip = project.tracks[0].clips[0];
  assert(clip.assetId !== 'ghost', '场景17: 悬空引用应被重映射');
  assert(project.assets.some((a) => a.id === clip.assetId), '场景17: 占位素材在素材库中');
  assert(report.missingAssets === 1, '场景17: 占位素材计数 1');
}

// 场景 18：工程参数单边修改 -> 采用修改方
{
  const base = makeProject([makeTrack('t1')]);
  const local = { ...makeProject([makeTrack('t1')]), bpm: 140 };
  const incoming = makeProject([makeTrack('t1')]);
  const { project } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.bpm === 140, '场景18: 本机改 bpm 应保留');
}

// 场景 19：旧版 v1 纯工程解析 -> base 回填为文件本体
{
  const old = makeProject([makeTrack('t1')]);
  const parsed = parseImportFile(JSON.stringify(old));
  assert(parsed.legacyBase === true, '场景19: 识别为旧版');
  assert(parsed.base.tracks[0].id === 't1', '场景19: base 用文件内工程回填');
}

// 场景 20：v2 包往返解析
{
  const p = makeProject([makeTrack('t1')]);
  const b = makeProject([]);
  const bundle = createProjectBundle(p, b);
  const parsed = parseImportFile(JSON.stringify(bundle));
  assert(parsed.legacyBase === false, '场景20: 识别为 v2');
  assert(parsed.project.tracks.length === 1 && parsed.base.tracks.length === 0, '场景20: 工程与基准各自解析');
}

// 场景 21：两边改成一样 -> 只保留一份，无冲突
{
  const base = makeProject([makeTrack('t1', [makeClip('c1', { start: 0 })])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 3 })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 3 })])]);
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips.length === 1, '场景21: 两边改成一样应只留一份');
  assert(report.clipConflicts === 0, '场景21: 不算冲突');
}

// 场景 22：片段冲突标记不应污染下一次合并（strip 后重新检测）
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const localConflict = makeProject([makeTrack('t1', [
    { ...makeClip('c1'), conflict: { kind: 'clip-both-edited', note: '旧冲突' } },
  ])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const { project } = mergeProjects(localConflict, incoming, base, { legacyBase: false });
  assert(!project.tracks[0].clips[0].conflict, '场景22: 双方均未改动时不应残留旧冲突标记');
}

// 场景 23：一边新增片段引用对方素材、同时对方在另一轨也新增相同 id（内容相同）-> 不冲突
{
  const base = makeProject([makeTrack('t1', []), makeTrack('t2', [])]);
  const asset = customAsset('a1');
  const local = makeProject(
    [makeTrack('t1', [makeClip('c1', { assetId: 'a1' })]), makeTrack('t2', [])],
    [asset],
  );
  const incoming = makeProject(
    [makeTrack('t1', [makeClip('c1', { assetId: 'a1' })]), makeTrack('t2', [])],
    [asset],
  );
  const { project, report } = mergeProjects(local, incoming, base, { legacyBase: false });
  assert(project.tracks[0].clips.length === 1, '场景23: 相同新增只留一份');
  assert(report.clipConflicts === 0, '场景23: 无冲突');
  assert(report.addedAssets === 0, '场景23: 相同素材不重复计数');
}

// 场景 24：撤销后 base 不前进（store 层行为在 UI 测，这里验证合并结果 idempotent：
// 用合并结果当 base 再导回来，无新增改动时应无冲突）
{
  const base = makeProject([makeTrack('t1', [makeClip('c1')])]);
  const local = makeProject([makeTrack('t1', [makeClip('c1', { start: 1 })])]);
  const incoming = makeProject([makeTrack('t1', [makeClip('c1', { start: 2, name: 'x' })])]);
  const first = mergeProjects(local, incoming, base, { legacyBase: false });
  const second = mergeProjects(first.project, first.project, first.project, { legacyBase: false });
  assert(second.report.clipConflicts === 0 && second.report.trackConflicts === 0, '场景24: 以合并结果为共同状态再次合并应无冲突');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
