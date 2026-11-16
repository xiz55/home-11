import {interpolate, random, useCurrentFrame, useVideoConfig} from 'remotion';
import {clamp, ease, pop} from '../anim';
import {SceneShell} from '../components/SceneShell';
import {C, FONT, goldText} from '../theme';
import {cue} from '../timing';

const Scale: React.FC<{angle: number}> = ({angle}) => {
	const rad = (angle * Math.PI) / 180;
	const px = 300;
	const py = 110;
	const half = 215;
	const lx = px - Math.cos(rad) * half;
	const ly = py - Math.sin(rad) * half;
	const rx = px + Math.cos(rad) * half;
	const ry = py + Math.sin(rad) * half;
	const pan = (x: number, y: number) => (
		<g>
			<line x1={x} y1={y} x2={x - 75} y2={y + 150} stroke={C.gold} strokeWidth={5} />
			<line x1={x} y1={y} x2={x + 75} y2={y + 150} stroke={C.gold} strokeWidth={5} />
			<path d={`M ${x - 95} ${y + 150} Q ${x} ${y + 235} ${x + 95} ${y + 150} Z`} fill="url(#g)" />
		</g>
	);
	return (
		<svg viewBox="0 0 600 560" width={560} height={523}>
			<defs>
				<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor={C.goldLight} />
					<stop offset="1" stopColor={C.goldDark} />
				</linearGradient>
			</defs>
			<rect x={288} y={90} width={24} height={390} rx={10} fill="url(#g)" />
			<path d="M 190 520 Q 300 440 410 520 Z" fill="url(#g)" />
			<rect x={150} y={515} width={300} height={22} rx={11} fill="url(#g)" />
			<line x1={lx} y1={ly} x2={rx} y2={ry} stroke="url(#g)" strokeWidth={16} strokeLinecap="round" />
			<circle cx={px} cy={py} r={26} fill={C.goldLight} />
			<circle cx={px} cy={52} r={16} fill={C.gold} />
			{pan(lx, ly)}
			{pan(rx, ry)}
		</svg>
	);
};

export const Hook: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const ask = cue('hook', 'كم');
	const asked = pop(frame, ask, fps);
	const angle = Math.sin(frame / 14) * 9 * (1 - 0.6 * asked) + asked * 11;
	const digits = [0, 1, 2, 3, 4].map((i) => Math.floor(random(`d${i}-${Math.floor(frame / 3)}`) * 10));
	return (
		<SceneShell duration={duration} first>
			<div
				dir="rtl"
				lang="ar"
				style={{
					position: 'absolute',
					top: 330,
					left: 60,
					right: 60,
					textAlign: 'center',
					fontFamily: FONT,
					scale: interpolate(frame, [0, 20], [1.03, 1], {...clamp, easing: ease}),
				}}
			>
				<div style={{fontSize: 136, fontWeight: 900, lineHeight: 1.15, ...goldText}}>أتعاب المحاماة</div>
				<div style={{fontSize: 68, fontWeight: 800, color: C.white, marginTop: 6}}>وش لون تنحسب؟</div>
			</div>
			<div
				style={{
					position: 'absolute',
					top: 590,
					left: 260,
					scale: interpolate(frame, [0, 18], [0.94, 1], {...clamp, easing: ease}),
				}}
			>
				<Scale angle={angle} />
			</div>
			<div
				dir="ltr"
				style={{
					position: 'absolute',
					top: 1105,
					left: 0,
					right: 0,
					display: 'flex',
					justifyContent: 'center',
					scale: asked,
					opacity: asked,
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 18,
						padding: '6px 44px',
						borderRadius: 40,
						backgroundColor: '#0B0F1A',
						border: `4px solid ${C.gold}`,
						boxShadow: '0 20px 60px rgba(201,164,92,0.35)',
						fontFamily: FONT,
						fontWeight: 900,
					}}
				>
					<span style={{fontSize: 64, color: C.soft}}>ريال</span>
					<span style={{fontSize: 120, color: C.goldLight, fontVariantNumeric: 'tabular-nums'}}>
						{(digits[0] % 9) + 1}
						{digits[1]},{digits[2]}
						{digits[3]}
						{digits[4]}
					</span>
					<span style={{fontSize: 120, color: C.white}}>؟</span>
				</div>
			</div>
		</SceneShell>
	);
};
