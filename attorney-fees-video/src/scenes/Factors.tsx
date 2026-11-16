import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {clamp, ease, enter, fmt, pop} from '../anim';
import {Heading, SceneShell} from '../components/SceneShell';
import {C, FONT, cardStyle} from '../theme';
import {cue} from '../timing';

const ROWS = [
	{word: 'نوع', label: 'نوع القضية وتعقيدها', level: 0.7, add: 4000},
	{word: 'وقيمة', label: 'قيمة المطالبة', level: 0.85, add: 6000},
	{word: 'والجهد', label: 'الجهد المتوقع', level: 0.6, add: 3000},
	{word: 'وخبرة', label: 'خبرة المحامي', level: 0.9, add: 5000},
	{word: 'درجة', label: 'درجات التقاضي', level: 0.5, add: 2000},
];

export const Factors: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const cues = ROWS.map((r) => cue('factors', r.word));
	const amount = ROWS.reduce(
		(sum, r, i) => sum + r.add * interpolate(frame, [cues[i], cues[i] + 18], [0, 1], {...clamp, easing: ease}),
		5000,
	);
	const bump = cues.reduce((m, c) => Math.max(m, frame >= c ? 1 - enter(frame, c, 12) : 0), 0);
	return (
		<SceneShell duration={duration}>
			<Heading>
				وش يغيّر <span style={{color: C.goldLight}}>المبلغ؟</span>
			</Heading>
			<div
				dir="rtl"
				style={{
					position: 'absolute',
					top: 470,
					left: 170,
					right: 170,
					padding: '16px 30px',
					borderRadius: 34,
					backgroundColor: '#0B0F1A',
					border: `4px solid ${C.gold}`,
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'baseline',
					gap: 18,
					fontFamily: FONT,
					fontWeight: 900,
					scale: 1 + 0.07 * bump,
					boxShadow: `0 0 ${30 + 60 * bump}px rgba(201,164,92,${0.25 + 0.4 * bump})`,
				}}
			>
				<span style={{fontSize: 104, color: C.goldLight, fontVariantNumeric: 'tabular-nums'}}>
					{fmt(Math.round(amount / 50) * 50)}
				</span>
				<span style={{fontSize: 52, color: C.soft}}>ريال</span>
			</div>
			<div style={{position: 'absolute', top: 680, left: 80, right: 80}}>
				{ROWS.map((r, i) => {
					const p = pop(frame, cues[i], fps);
					const fill = interpolate(frame, [cues[i] + 3, cues[i] + 24], [0, r.level], {...clamp, easing: ease});
					const wobble = frame > cues[i] + 24 ? Math.sin((frame - cues[i]) / 9 + i) * 0.03 : 0;
					return (
						<div
							key={r.label}
							dir="rtl"
							style={{
								...cardStyle,
								borderRadius: 26,
								padding: '14px 28px 18px',
								marginBottom: 16,
								fontFamily: FONT,
								opacity: Math.min(1, p * 1.5),
								translate: `${(1 - p) * 300}px 0px`,
							}}
						>
							<div style={{fontSize: 44, fontWeight: 800, color: C.white, marginBottom: 8}}>{r.label}</div>
							<div style={{height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.14)', position: 'relative'}}>
								<div
									style={{
										position: 'absolute',
										right: 0,
										top: 0,
										bottom: 0,
										width: `${(fill + wobble) * 100}%`,
										borderRadius: 9,
										backgroundImage: `linear-gradient(270deg, ${C.goldDark}, ${C.goldLight})`,
									}}
								/>
								<div
									style={{
										position: 'absolute',
										right: `calc(${(fill + wobble) * 100}% - 19px)`,
										top: -10,
										width: 38,
										height: 38,
										borderRadius: 19,
										backgroundColor: C.white,
										border: `6px solid ${C.gold}`,
										boxSizing: 'border-box',
									}}
								/>
							</div>
						</div>
					);
				})}
			</div>
		</SceneShell>
	);
};
