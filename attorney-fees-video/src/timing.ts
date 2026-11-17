import timings from './data/timings.json';

export const FPS = 30;
const LEAD = 0.12;
const TAIL = 2.6;

export type Word = {text: string; start: number; end: number};
export type SceneId = 'hook' | 'contract' | 'methods' | 'factors' | 'example' | 'tips' | 'outro';

export const normalize = (s: string) =>
	s.replace(/[ً-ْٰ]/g, '').replace(/[^ء-يa-zA-Z0-9]/g, '');

const raw = timings.scenes as {id: string; words: Word[]}[];

export const scenes = raw.map((s, i) => {
	const start = i === 0 ? 0 : s.words[0].start - LEAD;
	const end = i === raw.length - 1 ? timings.duration + TAIL : raw[i + 1].words[0].start - LEAD;
	const from = Math.round(start * FPS);
	return {id: s.id as SceneId, words: s.words, from, duration: Math.round(end * FPS) - from};
});

export const totalFrames = scenes[scenes.length - 1].from + scenes[scenes.length - 1].duration;

export const sceneOf = (id: SceneId) => {
	const scene = scenes.find((s) => s.id === id);
	if (!scene) throw new Error(`Unknown scene ${id}`);
	return scene;
};

// Frame (relative to the scene start) at which a spoken word begins.
export const cue = (id: SceneId, word: string, nth = 0) => {
	const scene = sceneOf(id);
	const match = scene.words.filter((w) => normalize(w.text) === normalize(word))[nth];
	if (!match) throw new Error(`Cue "${word}" not found in scene ${id}`);
	return Math.round(match.start * FPS) - scene.from;
};
