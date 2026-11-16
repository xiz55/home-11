import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {clamp, ease} from '../anim';

export const SceneShell: React.FC<{duration: number; children: React.ReactNode; last?: boolean; first?: boolean}> = ({
	duration,
	children,
	last,
	first,
}) => {
	const frame = useCurrentFrame();
	const out = last ? 1 : interpolate(frame, [duration - 8, duration], [1, 0], clamp);
	return (
		<AbsoluteFill
			style={{
				opacity: (first ? 1 : interpolate(frame, [0, 8], [0, 1], clamp)) * out,
				translate: `0px ${first ? 0 : interpolate(frame, [0, 12], [50, 0], {...clamp, easing: ease})}px`,
				scale: last ? 1 : interpolate(frame, [duration - 8, duration], [1, 1.06], clamp),
			}}
		>
			{children}
		</AbsoluteFill>
	);
};

export const Heading: React.FC<{children: React.ReactNode; top?: number; size?: number}> = ({
	children,
	top = 330,
	size = 88,
}) => (
	<div
		dir="rtl"
		lang="ar"
		style={{
			position: 'absolute',
			top,
			left: 80,
			right: 80,
			textAlign: 'center',
			fontFamily: 'Tajawal, TajawalLatin, sans-serif',
			fontWeight: 900,
			fontSize: size,
			color: '#fff',
			lineHeight: 1.2,
		}}
	>
		{children}
	</div>
);
