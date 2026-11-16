import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {clamp, enter, pop} from '../anim';
import {Heading, SceneShell} from '../components/SceneShell';
import {C, FONT, cardStyle} from '../theme';
import {cue} from '../timing';

const Icon: React.FC<{kind: number; t: number}> = ({kind, t}) => {
	if (kind === 0) {
		return (
			<svg width={150} height={150} viewBox="0 0 150 150">
				{[0, 1, 2, 3].map((i) => {
					const p = Math.min(1, Math.max(0, t / 8 - i * 0.6));
					return (
						<g key={i} opacity={p} transform={`translate(0 ${(1 - p) * -40})`}>
							<ellipse cx={75} cy={118 - i * 24} rx={52} ry={17} fill={C.goldDark} />
							<ellipse cx={75} cy={110 - i * 24} rx={52} ry={17} fill={C.goldLight} />
						</g>
					);
				})}
			</svg>
		);
	}
	if (kind === 1) {
		const pct = interpolate(t, [4, 26], [0, 0.28], clamp);
		return (
			<svg width={150} height={150} viewBox="0 0 150 150">
				<circle cx={75} cy={75} r={52} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={24} />
				<circle
					cx={75}
					cy={75}
					r={52}
					fill="none"
					stroke={C.goldLight}
					strokeWidth={24}
					strokeDasharray={`${pct * 327} 327`}
					transform="rotate(-90 75 75)"
				/>
				<text x={75} y={93} textAnchor="middle" fontSize={50} fontWeight={900} fill="#fff" fontFamily={FONT}>
					%
				</text>
			</svg>
		);
	}
	if (kind === 2) {
		return (
			<svg width={150} height={150} viewBox="0 0 150 150">
				<circle cx={75} cy={75} r={58} fill="none" stroke={C.goldLight} strokeWidth={10} />
				<line x1={75} y1={75} x2={75} y2={45} stroke="#fff" strokeWidth={9} strokeLinecap="round" transform={`rotate(${t * 1.5} 75 75)`} />
				<line x1={75} y1={75} x2={75} y2={30} stroke={C.gold} strokeWidth={7} strokeLinecap="round" transform={`rotate(${t * 18} 75 75)`} />
				<circle cx={75} cy={75} r={8} fill="#fff" />
			</svg>
		);
	}
	const w = interpolate(t, [4, 22], [0, 1], clamp);
	return (
		<svg width={150} height={150} viewBox="0 0 150 150">
			<rect x={10} y={30} width={130 * w * 0.4} height={38} rx={12} fill={C.goldLight} />
			<rect x={10 + 130 * 0.4 + 6} y={30} width={Math.max(0, 130 * 0.6 * w - 6)} height={38} rx={12} fill="rgba(255,255,255,0.3)" />
			<text x={75} y={122} textAnchor="middle" fontSize={54} fontWeight={900} fill="#fff" fontFamily={FONT}>
				+ %
			</text>
		</svg>
	);
};

const CARDS = [
	{word: 'مقطوع', title: 'مبلغ مقطوع', sub: 'ثابت للقضية كلها'},
	{word: 'نسبة', title: 'نسبة', sub: 'من قيمة المطالبة'},
	{word: 'بالساعة', title: 'بالساعة', sub: 'أجر عن كل ساعة'},
	{word: 'مختلطة', title: 'مختلطة', sub: 'مقدّم + نسبة'},
];

export const Methods: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const cues = CARDS.map((c) => cue('methods', c.word));
	const four = cue('methods', 'أربع');
	return (
		<SceneShell duration={duration}>
			<Heading>
				<span
					style={{
						display: 'inline-block',
						color: C.goldLight,
						fontSize: 130,
						scale: 0.6 + 0.4 * pop(frame, four, fps),
						marginLeft: 20,
					}}
				>
					4
				</span>
				طرق للحساب
			</Heading>
			<div
				dir="rtl"
				style={{
					position: 'absolute',
					top: 520,
					left: 70,
					right: 70,
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: 30,
				}}
			>
				{CARDS.map((c, i) => {
					const p = pop(frame, cues[i], fps);
					const next = cues[i + 1] ?? duration;
					const active = frame >= cues[i] && frame < next;
					const glow = enter(frame, cues[i], 8) * (1 - enter(frame, next, 8));
					return (
						<div
							key={c.title}
							style={{
								...cardStyle,
								height: 350,
								position: 'relative',
								display: 'flex',
								flexDirection: 'column',
								alignItems: 'center',
								justifyContent: 'center',
								fontFamily: FONT,
								opacity: Math.min(1, p * 1.5),
								scale: p * (1 + 0.05 * glow),
								rotate: `${(1 - p) * (i % 2 ? 8 : -8)}deg`,
								borderColor: active ? C.goldLight : C.cardBorder,
								backgroundColor: `rgba(201,164,92,${0.05 + 0.17 * glow})`,
								boxShadow: `0 24px 60px rgba(0,0,0,0.35), 0 0 ${60 * glow}px rgba(201,164,92,0.5)`,
							}}
						>
							<div
								style={{
									position: 'absolute',
									top: 18,
									right: 22,
									width: 54,
									height: 54,
									borderRadius: 27,
									backgroundColor: C.gold,
									color: C.navy,
									fontSize: 36,
									fontWeight: 900,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
								}}
							>
								{i + 1}
							</div>
							<Icon kind={i} t={frame - cues[i]} />
							<div style={{fontSize: 58, fontWeight: 900, color: C.white, marginTop: 8}}>{c.title}</div>
							<div style={{fontSize: 38, fontWeight: 700, color: C.soft}}>{c.sub}</div>
						</div>
					);
				})}
			</div>
		</SceneShell>
	);
};
