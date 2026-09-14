/**
 * Inline SVG icons.
 *
 * Drawn rather than typed as emoji or punctuation: a bare dot gives no clue
 * what the button does, and emoji render differently on every platform.
 * These inherit currentColor, so they follow the button's own state styling.
 */

/**
 * Microphone glyph, drawn to fill its button.
 *
 * The capsule body is solid rather than outlined: at this size a stroked
 * outline reads as a thin sketch, while a filled body reads instantly as a
 * microphone. The cradle and stem stay stroked so the shape is legible.
 */
export function MicrophoneIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11.5" rx="3" fill="currentColor" />
      <path
        d="M5.5 10.5a6.5 6.5 0 0 0 13 0"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <line x1="12" y1="17" x2="12" y2="21.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

/** Shown while listening, so the control reads as "stop" rather than "record". */
export function StopIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function SpeakerIcon({ muted }: { muted?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5z" strokeLinejoin="round" />
      {muted ? (
        <>
          <line x1="17" y1="9" x2="22" y2="15" strokeLinecap="round" />
          <line x1="22" y1="9" x2="17" y2="15" strokeLinecap="round" />
        </>
      ) : (
        <path d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" strokeLinecap="round" />
      )}
    </svg>
  );
}
