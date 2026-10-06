export type AssetSource = 'synthetic' | 'imported' | 'recorded';
export type TrackColor = '#2563eb' | '#0f9f7a' | '#d97706' | '#c2413b' | '#7c3aed' | '#0891b2';
export type ClipEffect = 'none' | 'lowpass' | 'highpass' | 'echo';

/** 合并后保留双方版本时，标出这份片段属于哪一边、为什么冲突 */
export type ClipConflictKind =
  | 'clip-both-edited' // 同一片段两边都改过
  | 'track-both-edited' // 所在轨道两边都改过
  | 'track-delete-modify' // 一边删轨、另一边改轨
  | 'moved-away-deleted' // 片段移走后原轨道被删
  | 'missing-track'; // 片段所在轨道在合并结果中不存在（兜底）

export interface ClipConflict {
  kind: ClipConflictKind;
  note: string;
}

export interface AudioAsset {
  id: string;
  name: string;
  source: AssetSource;
  duration: number;
  mimeType: string;
  dataUrl?: string;
  size?: number;
}

export interface AudioClip {
  id: string;
  assetId: string;
  name: string;
  start: number;
  duration: number;
  offset: number;
  fadeIn: number;
  fadeOut: number;
  effect: ClipEffect;
  effectAmount: number;
  /** 三路合并冲突标记；正常工程为 undefined */
  conflict?: ClipConflict;
}

export interface AudioTrack {
  id: string;
  name: string;
  color: TrackColor;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  height: number;
  clips: AudioClip[];
  /** 轨道参数两边都改过的字段名（片段上也会同步标出冲突） */
  trackConflicts?: string[];
}

export interface AudioProject {
  version: 1;
  name: string;
  bpm: number;
  snap: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  pixelsPerSecond: number;
  tracks: AudioTrack[];
  assets: AudioAsset[];
  updatedAt: number;
}

/** v2 导出包：工程本体 + 与同事分叉时的共同基准 */
export interface ProjectBundle {
  kind: 'waveforge-project';
  bundleVersion: 2;
  project: AudioProject;
  base: AudioProject;
  exportedAt: number;
}

export interface MergeReport {
  /** 合并后两份都保留的片段冲突 */
  clipConflicts: number;
  /** 轨道参数两边都改的冲突 */
  trackConflicts: number;
  /** 一边删除、另一边修改，按"删除优先"丢弃的条目数 */
  deleteModifyConflicts: number;
  /** 片段被一边移走、原轨道被另一边删除，已保留到新轨待确认 */
  moveDeleteConflicts: number;
  /** 合并中从对方补入素材库的素材数 */
  addedAssets: number;
  /** 对方片段引用了谁都没有的素材，生成的占位素材数 */
  missingAssets: number;
  /** 导入文件是旧版 v1 纯工程，已用文件内工程回填基准 */
  legacyBase: boolean;
}
