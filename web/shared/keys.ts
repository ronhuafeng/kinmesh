/**
 * Whether a key belongs to an input method still composing (pinyin, kana):
 * Enter commits its candidate and Escape cancels it, so the page acts on
 * neither.
 */
export function composing(
  event: KeyboardEvent | { nativeEvent: KeyboardEvent },
) {
  const key = 'nativeEvent' in event ? event.nativeEvent : event;
  // Safari sends the Enter that commits a candidate with isComposing false;
  // only its keyCode, 229, says the input method took it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return key.isComposing || key.key === 'Process' || key.keyCode === 229;
}
