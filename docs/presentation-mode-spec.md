# Presentation mode specification

Status: implemented for M13 browser and specification acceptance; physical-TV
acceptance remains open.

## 1. Purpose

Presentation mode is a controller-first skin for a device whose screen is
mirrored or cabled to a television. Emulation, storage, audio, input and the
game library remain on the loading device. The page does not create a second
window, cast receiver or remote-input protocol.

Presentation and Play Mode are two layouts over the same `PsxConsole`,
`PsxPlayer`, browser stores and active session. Switching modes must not
re-import content, replace memory cards or restart an active game.

## 2. Entry and persistence

Play Mode exposes **Enter Presentation Mode** under View. Entry:

1. closes the View dialog;
2. stores the Presentation preference in browser-local storage;
3. replaces the command bar, touch controller and local telemetry with the TV
   skin;
4. requests fullscreen for the complete play stage; and
5. requests landscape orientation when the browser supports it.

Fullscreen or orientation refusal is non-fatal. The TV skin remains usable and
reports the fullscreen failure in its own feedback area.

The mode preference survives reloads. A restored page opens the Presentation
library window; fullscreen still waits for a later user gesture when required
by the browser. **Play Mode** exits fullscreen, unlocks orientation and restores
the full local interface. A game paused beneath the Presentation window remains
paused when switching to Play Mode.

## 3. Playing and opening the menu

While a game runs with the menu closed, only the scaled game canvas is visible.
The first Presentation start in a page session shows a three-second hint naming
the supported menu gestures:

- L3 + R3 on any connected standard gamepad;
- Escape on the keyboard; or
- a two-finger tap on the play stage.

The game pauses when the menu opens. Keyboard and gamepad runtime sources then
detach through the established player lifecycle, allowing menu navigation to
read the same devices without sending inputs to the game. Closing the menu
resumes only when opening it caused the pause; a game already paused by the
user remains paused.

The complete L3 + R3 set fires once on its rising edge. Holding the chord does
not repeatedly toggle the menu. Activation inputs must return to neutral before
gameplay input is reattached, preventing Cross, Circle, L3, R3, Enter, Space or
Escape from leaking through the transition.

## 4. Navigation

Presentation uses visible focus suitable for television distance:

- D-pad or left stick up/down moves within a column;
- left/right crosses columns or changes an inline selector;
- Cross activates the focused action;
- Circle or Backspace closes disc selection first, then returns to the game;
- Enter and Space activate from the keyboard; and
- Escape toggles the root menu.

Pointer and touch activation remain available. With no active game, the Library
window cannot be dismissed because it is the only controller-accessible way to
start a stored title or return to Play Mode.

## 5. Window contents

The menu uses the production terminal design at TV density. A small action
column remains stable while the right column always shows Library. The header
shows the blue `// Presentation Mode` label on the left and the active title
and disc on the right.

The left column contains:

- Resume while a session exists, or Select Game while idle;
- soft Reset;
- Switch Disc for the active multi-disc title;
- Fit, Integer, Fill and Stretch scaling, including a pending selection before
  a game starts;
- Play Mode.

The explicit **Resume** action returns to the active session; closing through
the menu gesture or Back preserves a pause that existed before the menu opened.
With no active session and at least one playable stored title, **Select Game**
becomes the initial action focus. Activating it or pressing Right moves focus to
the first Library title.

Scaling remains enabled with no active session. Changing it updates the shared
View selection and the next game adopts that scaling as soon as its display is
created.

The permanent blue `// Library` panel shows its capitalized title count and
aggregate stored size on the right, and lists only games already stored in this
browser. The active title remains visually selected in that list. Each title is
itself a launch button. A
single-disc title starts immediately. A multi-disc title opens a focused modal
of disc buttons before any startup begins. Activating another title replaces
the active session. Choosing another disc for the active title uses in-session
disc insertion. Startup and disc operations cover the menu with their current
loading status until they finish or report an error. Import, rename, removal
and storage administration remain in Play Mode.

## 6. Play Mode controls

Named and quick states, mute, volume and controller configuration remain in
Play Mode. Presentation does not duplicate controls that are not needed to
choose and launch a television game. Existing controller quick-state shortcuts
remain runtime input and continue to work while the menu is closed.

## 7. Excluded administration

Presentation does not expose firmware replacement, game import or deletion,
memory-card import/export, game renaming, controller-type restart or destructive
state deletion. Those workflows remain one **Play Mode** action away and keep
their existing confirmation and storage behavior.

The on-screen controller is hidden in Presentation because it would also be
mirrored to the television. Touch remains available for the menu gesture and
menu actions.

## 8. Acceptance

Automated acceptance requires:

1. menu-gesture tests proving partial, held, released and repeated chord edges;
2. a browser probe proving mode entry, the reduced action set, TV layout,
   local-chrome removal, Select Game activation and Right navigation, direct
   Library launch, conditional disc selection and loading status, Play Mode
   exit and reload restoration;
3. the existing M12 production probe to remain green; and
4. TypeScript checks and the complete specification suite to pass.

Physical acceptance requires starting a stored game on a mirrored display,
opening and closing the menu from a gamepad, launching games directly,
switching a multi-disc title through its selection modal, resetting, changing
scaling, and returning to Play Mode without a stuck input or unintended game
action.
