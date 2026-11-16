import {AbsoluteFill, random, useCurrentFrame} from 'remotion';
import {C} from '../theme';

const DOTS = new Array(34).fill(0).map((_, i) => ({
	x: random(`x${i}`) * 1080,
	y: random(`y${i}`) * 1920,
	r: 2 + random(`r${i}`) * 4,
	speed: 0.25 + random(`s${i}`) * 0.6,
	phase: random(`p${i}`) * Math.PI * 2,
}));

export const Background: React.FC = () => {
	const frame = useCurrentFrame();
	return (
		<AbsoluteFill
			style={{backgroundImage: `linear-gradient(165deg, ${C.bg1} 0%, ${C.bg0} 60%, #05070D 100%)`}}
		>
			<div
				style={{
					position: 'absolute',
					width: 900,
					height: 900,
					borderRadius: '50%',
					left: -250 + Math.sin(frame / 90) * 80,
					top: 150 + Math.cos(frame / 110) * 90,
					backgroundImage: 'radial-gradient(circle, rgba(201,164,92,0.20) 0%, rgba(201,164,92,0) 65%)',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					width: 1000,
					height: 1000,
					borderRadius: '50%',
					left: 380 + Math.cos(frame / 100) * 90,
					top: 900 + Math.sin(frame / 80) * 100,
					backgroundImage: 'radial-gradient(circle, rgba(74,98,180,0.22) 0%, rgba(74,98,180,0) 65%)',
				}}
			/>
			<svg width={1080} height={1920} style={{position: 'absolute'}}>
				{DOTS.map((d, i) => (
					<circle
						key={i}
						cx={d.x + Math.sin(frame / 50 + d.phase) * 18}
						cy={(((d.y - frame * d.speed) % 1920) + 1920) % 1920}
						r={d.r}
						fill={C.gold}
						opacity={0.12 + 0.2 * Math.abs(Math.sin(frame / 40 + d.phase))}
					/>
				))}
			</svg>
		</AbsoluteFill>
	);
};
