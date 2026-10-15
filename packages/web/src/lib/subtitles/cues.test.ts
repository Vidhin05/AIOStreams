import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAssCues } from './cues';

const SCRIPT = `[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: Sign,Arial,48,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello
Dialogue: 0,0:00:01.00,0:00:04.00,Sign,,0,0,0,,{\\an8}On the door
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(960,1000)}By the mark
`;

describe('parseAssCues', () => {
  it('keeps a sign at the top and a positioned line on the picture', () => {
    const cues = parseAssCues(SCRIPT);
    assert.equal(cues.length, 3);
    assert.equal(cues[0].text, 'Hello');
    assert.deepEqual(cues[0].place, { anchor: 2 });
    assert.equal(cues[1].text, 'On the door');
    assert.deepEqual(cues[1].place, { anchor: 8 });
    assert.equal(cues[2].text, 'By the mark');
    assert.equal(cues[2].place?.anchor, 2);
    assert.ok(Math.abs((cues[2].place?.x ?? 0) - 50) < 0.01);
    assert.ok(Math.abs((cues[2].place?.y ?? 0) - (1000 / 1080) * 100) < 0.01);
  });
});
