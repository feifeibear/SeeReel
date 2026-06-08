# Gallery Sharing

Status: active
Owner: SeeReel
Last Reviewed: 2026-06-05

## Purpose

SeeReel Gallery is the creator sharing surface. It lets users publish a completed or in-progress session as a public, remixable work so other visitors can preview the generated video and copy the full session into their own workspace.

## Scope

- Gallery data persisted in the SeeReel store.
- Public Gallery page in the web app.
- Clean browser routes for Studio and Gallery.
- API routes for listing gallery items, publishing a session to Gallery, reading one item, copying an item, and deleting a published item.
- Session-copy semantics for prompts, shots, asset wiring, generated media, stitch outputs, and owner isolation.

## Non-Goals

- Moderation, ranking, likes, comments, search, and creator profiles.
- Cross-device authenticated accounts.
- Paid generation on copy. Copying a gallery item does not submit new Seedance or Seedream jobs.
- Moderation-grade public takedown workflow.

## User Stories

- As a creator, I can publish my current session to Gallery from the web app.
- As a visitor, I can open Gallery and preview shared generated videos.
- As a visitor, I can copy a gallery item into my own session list and continue editing from that copy.
- As a creator, I can delete a Gallery item I published when I no longer want it shown publicly.
- As a creator, I can delete or keep editing my original session without breaking the already-published Gallery item.

## Product Rules

- Publishing is explicit. A private session appears in Gallery only after the user chooses to publish it.
- Gallery items are public across anonymous browser users.
- The default app route is Studio/Canvas; once a session is selected, the shareable URL is `/canvas/:sessionId`.
- Gallery is reachable at `/gallery`. UI navigation must provide a visible Gallery button from Studio and a visible Canvas/Studio button from Gallery.
- Legacy hash URLs (`#/gallery`, `#/s/:sessionId`) may remain readable for old links, but new links and UI navigation use clean paths.
- A Gallery item stores a copyable snapshot of the session, shots, and referenced assets at publish time.
- Preview video selection prioritizes the current final/narration video, then ready stitch-job output, then the first available shot video.
- Copying a Gallery item creates new session, shot, and asset ids owned by the copying visitor.
- Copying preserves editable prompts, asset references, generated media URLs, stitch outputs, and shot order, while clearing in-flight task ids and token usage history.
- The copied session is selected immediately so the visitor can continue creating without hunting through history.
- Deleting a Gallery item removes only the public Gallery item. It must not delete the original session, copied sessions, assets, media files, or existing remixes.
- Gallery items published after this rule carry the publishing owner internally so other current-owner visitors cannot delete them. Legacy items without an owner may still be removed to keep old local data manageable.
- Gallery API responses expose a viewer-scoped `canDelete` affordance. The web app must show the delete button only when `canDelete` is true; localhost shared-review/admin mode may delete any visible Gallery item for local cleanup.

## Acceptance Criteria

- [ ] A session can be published to Gallery through `POST /api/gallery` with `sessionId` in the request body.
- [ ] `GET /api/gallery` returns the published item with title, description, creator label, tags, preview video URL, shot count, duration, and snapshot data.
- [ ] The web app has a Gallery page reachable from the sidebar and `/gallery`.
- [ ] The default logged-in/local entry route is Studio/Canvas, and selected sessions use `/canvas/:sessionId`.
- [ ] Studio has a visible button to switch to Gallery, and Gallery has a visible button to switch back to Canvas.
- [ ] Gallery cards show a video preview when the published session has generated media.
- [ ] Copying a Gallery item through `POST /api/gallery/:galleryId/copy` creates a new owned session with remapped shot and asset ids.
- [ ] The web app copy action selects the newly copied session for editing.
- [ ] Deleting a Gallery item through `DELETE /api/gallery/:galleryId` removes it from `GET /api/gallery` and prevents future copies.
- [ ] The web app Gallery card exposes a delete action that confirms before deletion and removes the card after success.
- [ ] The web app Gallery card hides the delete action for items the current viewer cannot delete, while localhost shared-review/admin Gallery cards remain deletable.
- [ ] A Gallery item owned by another current owner cannot be deleted.
- [ ] Deleting the source session after publishing does not prevent the Gallery item from being copied.

## Verification

- [ ] `npm run smoke:gallery-sharing`
- [ ] `npm run smoke:specs`
- [ ] `npm run smoke:secrets`
- [ ] `npm run build`
- [ ] `npm run verify:offline`
- [ ] Browser smoke: open `/gallery`, publish a session, preview the Gallery card, copy it, and verify the copied session opens at `/canvas/:sessionId`.

## Change Policy

Update this spec before changing Gallery publish/copy data shape, Gallery page behavior, ownership rules, or preview selection rules.
