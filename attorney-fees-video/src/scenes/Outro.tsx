import {Img, random, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {enter, pop} from '../anim';
import {SceneShell} from '../components/SceneShell';
import {C, FONT, goldText} from '../theme';
import {cue} from '../timing';

const CONFETTI = new Array(46).fill(0).map((_, i) => ({
	angle: random(`a${i}`) * Math.PI * 2,
	speed: 14 + random(`v${i}`) * 26,
	size: 12 + random(`z${i}`) * 18,
	spin: (random(`q${i}`) - 0.5) * 30,
	light: random(`l${i}`) > 0.5,
}));

export const Outro: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const card = pop(frame, 2, fps);
	const tagAt = cue('outro', 'قبل');
	const tag = pop(frame, tagAt, fps);
	return (
		<SceneShell duration={duration} last>
			<svg width={1080} height={1920} style={{position: 'absolute'}}>
				{CONFETTI.map((c, i) => {
					const t = Math.max(0, frame - 4);
					const d = c.speed * t * Math.exp(-t / 60);
					const x = 540 + Math.cos(c.angle) * d * 2.2;
					const y = 720 + Math.sin(c.angle) * d * 2.2 + t * t * 0.12;
					return (
						<rect
							key={i}
							x={x}
							y={y}
							width={c.size}
							height={c.size * 0.5}
							fill={c.light ? C.goldLight : C.gold}
							opacity={Math.max(0, 1 - t / 80)}
							transform={`rotate(${c.spin * t} ${x} ${y})`}
						/>
					);
				})}
			</svg>
			<div
				style={{
					position: 'absolute',
					top: 290,
					left: 160,
					width: 760,
					height: 780,
					borderRadius: 60,
					backgroundColor: C.white,
					boxShadow: '0 40px 120px rgba(201,164,92,0.45)',
					overflow: 'hidden',
					scale: card * (1 + Math.sin(frame / 25) * 0.01),
					rotate: `${(1 - card) * -8}deg`,
				}}
			>
				<Img src={staticFile('brand/logo.jpg')} style={{width: 720, margin: '26px 20px'}} />
				<div
					style={{
						position: 'absolute',
						top: 0,
						bottom: 0,
						width: 220,
						left: -300 + enter(frame, 18, 30) * 1300,
						backgroundImage: 'linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 100%)',
						rotate: '12deg',
					}}
				/>
			</div>
			<div
				dir="rtl"
				lang="ar"
				style={{
					position: 'absolute',
					top: 1110,
					left: 60,
					right: 60,
					textAlign: 'center',
					fontFamily: FONT,
					fontWeight: 900,
					fontSize: 84,
					lineHeight: 1.3,
					opacity: Math.min(1, tag * 1.5),
					scale: 0.8 + 0.2 * tag,
					...goldText,
				}}
			>
				اعرف حقك… قبل لا توقّع
			</div>
		</SceneShell>
	);
};
