// Generates public/voiceover/voiceover.mp3 and src/data/timings.json from src/data/script.json.
// Usage: node scripts/generate-voiceover.mjs [voiceId] [modelId]
// The API key comes from ELEVENLABS_API_KEY (or is injected by the environment's network proxy).
import {readFileSync, writeFileSync} from 'node:fs';

const voiceId = process.argv[2] ?? 't9akNmCDhz230CEXOYmn'; // Abdullah Saadoun
const modelId = process.argv[3] ?? 'eleven_multilingual_v2';
const {scenes} = JSON.parse(readFileSync('src/data/script.json', 'utf8'));
const text = scenes.map((s) => s.text).join(' ');

const res = await fetch(
	`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
	{
		method: 'POST',
		headers: {
			'xi-api-key': process.env.ELEVENLABS_API_KEY ?? 'proxy-injected',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			text,
			model_id: modelId,
			language_code: modelId === 'eleven_multilingual_v2' ? undefined : 'ar',
			voice_settings: {stability: 0.45, similarity_boost: 0.8, style: 0.35, speed: 1.08},
		}),
	},
);
const json = await res.json();
if (!json.audio_base64) {
	console.error(JSON.stringify(json));
	process.exit(1);
}
writeFileSync('public/voiceover/voiceover.mp3', Buffer.from(json.audio_base64, 'base64'));

const {characters, character_start_times_seconds: st, character_end_times_seconds: en} = json.alignment;
const words = [];
let cur = null;
characters.forEach((ch, i) => {
	if (/\s/.test(ch)) {
		if (cur) words.push(cur);
		cur = null;
		return;
	}
	if (!cur) cur = {text: '', start: st[i], end: en[i]};
	cur.text += ch;
	cur.end = en[i];
});
if (cur) words.push(cur);

let index = 0;
const out = scenes.map((s) => {
	const count = s.text.split(/\s+/).length;
	const slice = words.slice(index, index + count);
	index += count;
	return {id: s.id, words: slice};
});
if (index !== words.length) throw new Error(`word mismatch ${index} vs ${words.length}`);
writeFileSync(
	'src/data/timings.json',
	JSON.stringify({voiceId, duration: en[en.length - 1], scenes: out}, null, 1),
);
console.log('ok', en[en.length - 1], 'seconds,', words.length, 'words');
