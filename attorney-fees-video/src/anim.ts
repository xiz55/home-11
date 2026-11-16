import {Easing, interpolate, spring} from 'remotion';

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const ease = Easing.bezier(0.16, 1, 0.3, 1);

export const enter = (frame: number, start: number, dur = 14) =>
	interpolate(frame, [start, start + dur], [0, 1], {...clamp, easing: ease});

export const pop = (frame: number, start: number, fps: number) =>
	frame < start
		? 0
		: spring({frame: frame - start, fps, config: {damping: 12, stiffness: 170, mass: 0.7}});

export const countTo = (frame: number, start: number, dur: number, from: number, to: number) =>
	Math.round(interpolate(frame, [start, start + dur], [from, to], {...clamp, easing: ease}));

export const fmt = (n: number) => n.toLocaleString('en-US');
