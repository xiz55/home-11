import {useCurrentFrame, useVideoConfig} from 'remotion';
import {enter, pop} from '../anim';
import {Heading, SceneShell} from '../components/SceneShell';
import {C, FONT, cardStyle} from '../theme';
import {cue} from '../timing';

const TIPS = [
	{word: 'اطلب', text: 'اطلب عقد مكتوب وواضح'},
	{word: 'واعرف', text: 'اعرف وش تشمل الأتعاب'},
	{word: 'واتفق', text: 'اتفق على مواعيد الدفع'},
	{word: 'واسأل', text: 'اسأل: وش يصير لو صلح؟'},
];

export const Tips: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const cues = TIPS.map((t) => cue('tips', t.word));
	return (
		<SceneShell duration={duration}>
			<Heading>
				قبل لا <span style={{color: C.goldLight}}>توقّع</span>
			</Heading>
			<div style={{position: 'absolute', top: 490, left: 80, right: 80}}>
				{TIPS.map((t, i) => {
					const p = pop(frame, cues[i], fps);
					const check = enter(frame, cues[i] + 10, 12);
					const next = cues[i + 1] ?? duration;
					const active = frame >= cues[i] && frame < next;
					return (
						<div
							key={t.text}
							dir="rtl"
							style={{
								...cardStyle,
								borderRadius: 30,
								height: 164,
								marginBottom: 24,
								padding: '0 30px',
								display: 'flex',
								alignItems: 'center',
								gap: 26,
								fontFamily: FONT,
								opacity: Math.min(1, p * 1.5),
								scale: (0.7 + 0.3 * p) * (active ? 1.03 : 1),
								translate: `0px ${(1 - p) * 80}px`,
								borderColor: active ? C.goldLight : C.cardBorder,
								backgroundColor: active ? 'rgba(201,164,92,0.2)' : C.card,
							}}
						>
							<svg width={88} height={88} viewBox="0 0 88 88" style={{flexShrink: 0}}>
								<rect x={4} y={4} width={80} height={80} rx={22} fill={`rgba(79,208,139,${check})`} stroke={check > 0 ? C.green : C.gold} strokeWidth={6} />
								<path
									d="M 22 46 L 38 62 L 66 28"
									fill="none"
									stroke="#fff"
									strokeWidth={10}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeDasharray={70}
									strokeDashoffset={70 * (1 - check)}
								/>
							</svg>
							<div style={{fontSize: 56, fontWeight: 800, color: C.white}}>{t.text}</div>
						</div>
					);
				})}
			</div>
		</SceneShell>
	);
};
