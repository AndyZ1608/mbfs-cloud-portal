export const CHARACTER_DELAY_MS = 50;
export const ENTER_DELAY_MS = 100;

const KEYSYM = Object.freeze({
  Tab: 0xff09,
  Enter: 0xff0d,
  ShiftLeft: 0xffe1,
});

const PHYSICAL_KEYS = new Map([
  ['`', ['Backquote', false]], ['~', ['Backquote', true]],
  ['1', ['Digit1', false]], ['!', ['Digit1', true]],
  ['2', ['Digit2', false]], ['@', ['Digit2', true]],
  ['3', ['Digit3', false]], ['#', ['Digit3', true]],
  ['4', ['Digit4', false]], ['$', ['Digit4', true]],
  ['5', ['Digit5', false]], ['%', ['Digit5', true]],
  ['6', ['Digit6', false]], ['^', ['Digit6', true]],
  ['7', ['Digit7', false]], ['&', ['Digit7', true]],
  ['8', ['Digit8', false]], ['*', ['Digit8', true]],
  ['9', ['Digit9', false]], ['(', ['Digit9', true]],
  ['0', ['Digit0', false]], [')', ['Digit0', true]],
  ['-', ['Minus', false]], ['_', ['Minus', true]],
  ['=', ['Equal', false]], ['+', ['Equal', true]],
  ['[', ['BracketLeft', false]], ['{', ['BracketLeft', true]],
  [']', ['BracketRight', false]], ['}', ['BracketRight', true]],
  ['\\', ['Backslash', false]], ['|', ['Backslash', true]],
  [';', ['Semicolon', false]], [':', ['Semicolon', true]],
  ["'", ['Quote', false]], ['"', ['Quote', true]],
  [',', ['Comma', false]], ['<', ['Comma', true]],
  ['.', ['Period', false]], ['>', ['Period', true]],
  ['/', ['Slash', false]], ['?', ['Slash', true]],
  [' ', ['Space', false]],
]);

export class UnsupportedConsoleCharacterError extends Error {
  constructor(position, codePoint) {
    super(`Ký tự không được hỗ trợ tại vị trí ${position + 1} (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}).`);
    this.name = 'UnsupportedConsoleCharacterError';
    this.position = position;
    this.codePoint = codePoint;
  }
}

export function mapConsoleCharacter(character, position = 0) {
  if (character === '\n') return { kind: 'enter', keysym: KEYSYM.Enter, code: 'Enter', shift: false };
  if (character === '\t') return { kind: 'tab', keysym: KEYSYM.Tab, code: 'Tab', shift: false };

  const codePoint = character.codePointAt(0);
  if (codePoint >= 0x61 && codePoint <= 0x7a) {
    return { kind: 'character', keysym: codePoint, code: `Key${character.toUpperCase()}`, shift: false };
  }
  if (codePoint >= 0x41 && codePoint <= 0x5a) {
    return { kind: 'character', keysym: codePoint, code: `Key${character}`, shift: true };
  }
  const physical = PHYSICAL_KEYS.get(character);
  if (physical) return { kind: 'character', keysym: codePoint, code: physical[0], shift: physical[1] };
  throw new UnsupportedConsoleCharacterError(position, codePoint);
}

export function tokenizeConsoleText(text, appendEnter = false) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const characters = Array.from(normalized);
  const tokens = characters.map((character, position) => mapConsoleCharacter(character, position));
  if (appendEnter && tokens.at(-1)?.kind !== 'enter') {
    tokens.push(mapConsoleCharacter('\n', characters.length));
  }
  return tokens;
}

export function sendConsoleToken(rfb, token) {
  if (!rfb || typeof rfb.sendKey !== 'function') throw new Error('Phiên VNC không khả dụng.');
  if (!token.shift) {
    rfb.sendKey(token.keysym, token.code);
    return;
  }

  rfb.sendKey(KEYSYM.ShiftLeft, 'ShiftLeft', true);
  try {
    rfb.sendKey(token.keysym, token.code);
  } finally {
    rfb.sendKey(KEYSYM.ShiftLeft, 'ShiftLeft', false);
  }
}
