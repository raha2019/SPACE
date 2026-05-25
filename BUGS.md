# BUGS.md

Bugs identified and fixed in the SPACE v1 codebase.

---

## Bug 1: saveCustomElement calls nonexistent DOM node

**Description:** After saving or deleting a custom tool element, the UI list inside the
Element Builder modal was not refreshed. The modal continued to show stale entries.

**Root cause:** `saveCustomElement()` (modals.js line 695) and `deleteCustomElement()`
(modals.js line 756) both called `renderCustomElementList()`. That function queries
`document.getElementById("ebCustomList")`, but no element with that ID exists in
index.html. The function returned immediately every time. The correct ID is
`chooserExistingList`, maintained by `renderChooserExisting()`.

**Fix applied:** Replaced both calls to `renderCustomElementList()` with
`renderChooserExisting()`, which correctly targets `#chooserExistingList`.

**Files changed:** `v1/js/modals.js`

---

## Bug 2: drawRiskZone ignores offsetX / offsetY for shape-type zones

**Description:** Shape-type risk zone overlays (SVG rect inside a composite zone)
appeared in the wrong position on the stage when the user had set a positional offset
in the Element Builder.

**Root cause:** `drawRiskZone()` in render.js only checked `if(zone.offset)`, where
`offset` is a legacy scalar API from the old builder. The current builder saves
`offsetX` and `offsetY` as separate numeric fields. Zones built with the current
builder always had `offset === undefined`, so the translate transform was never applied.

**Fix applied:** Updated the shape-type branch to detect all three cases:
- new API: `zone.offsetX` / `zone.offsetY` used directly
- legacy API: scalar `zone.offset` projected along `axisAngle` to get `dx`/`dy`
- no offset: no transform applied

**Files changed:** `v1/js/render.js`

---

## Bug 3: Structural shape delete button uses literal "x" instead of times entity

**Description:** Delete buttons on structural shape rows inside the Element Builder
displayed a plain lowercase "x" rather than the multiplication sign used elsewhere
in the UI.

**Root cause:** The innerHTML string for structural shape rows (modals.js lines 818
and 829) used the literal character `x` in the button label. Tool builder delete
buttons correctly used the HTML entity `&times;` (renders as x).

**Fix applied:** Changed both structural delete button labels from `x` to `&times;`.

**Files changed:** `v1/js/modals.js`
