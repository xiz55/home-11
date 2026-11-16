import {useCurrentFrame, useVideoConfig} from 'remotion';
import {countTo, enter, fmt, pop} from '../anim';
import {SceneShell} from '../components/SceneShell';
import {C, FONT} from '../theme';
import {cue} from '../timing';

export const Example: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const rows = [
		{label: 'قيمة المطالبة', at: cue('example', 'بميتين'), valueAt: cue('example', 'بميتين'), value: 200000, muted: true},
		{label: 'دفعة مقدّمة', at: cue('example', 'خمسة'), valueAt: cue('example', 'خمسة'), value: 5000},
		{label: 'نسبة 10% عند الكسب', at: cue('example', 'وعشرة'), valueAt: cue('example', 'عشرين'), value: 20000},
		{label: 'المجموع', at: cue('example', 'المجموع'), valueAt: cue('example', 'المجموع') + 6, value: 25000, strong: true},
		{label: 'ضريبة القيمة المضافة 15%', at: cue('example', 'خمسطعش'), valueAt: cue('example', 'خمسطعش'), value: 3750},
	];
	const totalAt = cue('example', 'الإجمالي');
	const total = pop(frame, totalAt, fps);
	return (
		<SceneShell duration={duration}>
			<div
				style={{
					position: 'absolute',
					top: 330,
					left: 90,
					right: 90,
					borderRadius: 36,
					backgroundColor: '#FBF8F1',
					boxShadow: '0 40px 90px rgba(0,0,0,0.5)',
					padding: '34px 40px 40px',
					fontFamily: FONT,
					rotate: `${Math.sin(frame / 40) * 0.6}deg`,
				}}
			>
				<div dir="rtl" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
					<div style={{fontSize: 66, fontWeight: 900, color: C.navy}}>مثال عملي</div>
					<div
						style={{
							padding: '8px 26px',
							borderRadius: 40,
							backgroundColor: C.navy,
							color: C.goldLight,
							fontSize: 36,
							fontWeight: 800,
						}}
					>
						طريقة مختلطة
					</div>
				</div>
				<div style={{height: 6, backgroundColor: C.gold, borderRadius: 3, margin: '18px 0 10px'}} />
				{rows.map((r) => {
					const p = enter(frame, r.at, 10);
					const hot = 1 - enter(frame, r.at + 10, 20);
					return (
						<div
							key={r.label}
							dir="rtl"
							style={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								height: 104,
								padding: '0 18px',
								borderRadius: 18,
								borderBottom: r.strong ? 'none' : '3px dashed #D9D3C4',
								backgroundColor: r.strong
									? 'rgba(201,164,92,0.28)'
									: `rgba(201,164,92,${frame >= r.at ? 0.3 * hot : 0})`,
								opacity: p,
								translate: `${(1 - p) * 120}px 0px`,
							}}
						>
							<span style={{fontSize: r.strong ? 52 : 42, fontWeight: r.strong ? 900 : 700, color: r.muted ? '#6B6F7B' : C.navy}}>
								{r.label}
							</span>
							<span
								dir="ltr"
								style={{
									fontSize: r.strong ? 64 : 54,
									fontWeight: 900,
									color: r.muted ? '#6B6F7B' : C.navy,
									fontVariantNumeric: 'tabular-nums',
									opacity: enter(frame, r.valueAt, 6),
								}}
							>
								{fmt(countTo(frame, r.valueAt, 16, 0, r.value))}
							</span>
						</div>
					);
				})}
				<div
					dir="rtl"
					style={{
						marginTop: 24,
						borderRadius: 28,
						padding: '20px 30px',
						backgroundImage: `linear-gradient(135deg, ${C.navy}, #2A3050)`,
						border: `5px solid ${C.gold}`,
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'center',
						opacity: Math.min(1, total * 1.5),
						scale: 0.8 + 0.2 * total,
						boxShadow: `0 0 ${50 * total}px rgba(201,164,92,0.7)`,
					}}
				>
					<span style={{fontSize: 56, fontWeight: 900, color: C.white}}>الإجمالي</span>
					<span dir="ltr" style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
						<span style={{fontSize: 40, fontWeight: 800, color: C.soft}}>ريال</span>
						<span style={{fontSize: 92, fontWeight: 900, color: C.goldLight, fontVariantNumeric: 'tabular-nums'}}>
							{fmt(countTo(frame, totalAt, 30, 25000, 28750))}
						</span>
					</span>
				</div>
			</div>
		</SceneShell>
	);
};
