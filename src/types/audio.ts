export type AssetSource = 'synthetic' | 'imported' | 'recorded';
export type TrackColor = '#2563eb' | '#0f9f7a' | '#d97706' | '#c2413b' | '#7c3aed' | '#0891b2';
export type ClipEffect = 'none' | 'lowpass' | 'highpass' | 'echo';

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
  conflict?: boolean;
  conflictNote?: string;
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
  /**
   * 三方合并用的共同祖先快照。导出工程时写入，导入时作为 base；
   * 旧版工程没有该字段，导入时按当时工程内容回填一份基准。
   */
  base?: AudioProject;
}
