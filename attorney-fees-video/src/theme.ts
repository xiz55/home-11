import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

export const C = {
	bg0: '#0A0E19',
	bg1: '#151C30',
	navy: '#1A1D29',
	gold: '#C9A45C',
	goldLight: '#EBD398',
	goldDark: '#9A7636',
	white: '#FFFFFF',
	soft: 'rgba(255,255,255,0.72)',
	card: 'rgba(255,255,255,0.055)',
	cardBorder: 'rgba(201,164,92,0.38)',
	green: '#4FD08B',
};

export const FONT = 'Tajawal, TajawalLatin, sans-serif';

for (const weight of ['500', '700', '800', '900']) {
	loadFont({
		family: 'Tajawal',
		url: staticFile(`fonts/tajawal-arabic-${weight}-normal.woff2`),
		weight,
	});
}
for (const weight of ['700', '900']) {
	loadFont({
		family: 'TajawalLatin',
		url: staticFile(`fonts/tajawal-latin-${weight}-normal.woff2`),
		weight,
	});
}

export const goldText: React.CSSProperties = {
	backgroundImage: `linear-gradient(180deg, ${C.goldLight} 0%, ${C.gold} 55%, ${C.goldDark} 100%)`,
	WebkitBackgroundClip: 'text',
	backgroundClip: 'text',
	color: 'transparent',
};

export const cardStyle: React.CSSProperties = {
	backgroundColor: C.card,
	border: `2px solid ${C.cardBorder}`,
	borderRadius: 36,
	boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
};

export const PHONE = '0537256669';
