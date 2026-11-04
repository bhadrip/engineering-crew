# Pet Store catalog website

Visitors need to browse the same fictional pets as the CLI from a phone or
desktop. The catalog initially contains Mochi the cat and Pip the dog. This
epic delivers the website plan. The plan should be usable by an engineer and
give QA observable acceptance checks.

The draft calls for one catalog page, a heading, a species filter, and a list
of pets showing name and species. Review how a visitor finds a pet, how the
filter behaves with keyboard and touch, and what happens while the catalog is
loading, unavailable, empty, or has no matches. Plan for long names and more
pets. Images are optional and must have a sensible fallback. Use the same
catalog data and keep accounts, checkout, and editing outside this epic.

- **WEB-1** covers browsing both pets and filtering by species without leaving
  the catalog page.
- **WEB-2** covers keyboard and touch operation, focus, accessible status
  updates, and distinct loading, empty, no-match, and unavailable states.
- **WEB-3** covers readable typography, contrast, responsive hierarchy, and
  reflow without clipping long names or hiding controls.
