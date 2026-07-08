# Zotero collection compatibility

Primary reference:

```text
references/dataserver/tests/remote/tests/3/collection.test.js
```

## Implemented

- `GET /users/:userID/collections`
- `GET /users/:userID/collections/:collectionKey`
- `POST /users/:userID/collections`
- `DELETE /users/:userID/collections?collectionKey=...`
- `GET /groups/:groupID/collections`
- `GET /groups/:groupID/collections/:collectionKey`
- `POST /groups/:groupID/collections`
- `DELETE /groups/:groupID/collections?collectionKey=...`
- `GET /users/:userID/collections/:collectionKey/items`
- `GET /users/:userID/collections/:collectionKey/items/top`
- `GET /groups/:groupID/collections/:collectionKey/items`
- `GET /groups/:groupID/collections/:collectionKey/items/top`
- D1-backed collection persistence through the existing `collections` table.
- In-memory collection persistence for local direct app tests.
- Batch create/update response shape with `success`, `successful`, `failed`,
  `unchanged`, and `Last-Modified-Version`.
- Parent collection validation, including D1 async parent lookup.
- Missing collection-key validation before user/group item creation.
- Missing collection-key validation before user/group item `PATCH` and `PUT`.
- User/group item `PATCH` and `PUT` can change `data.collections`.
- Child items with non-empty direct collections are rejected with Zotero's
  expected `Child items cannot be assigned to collections` message.
- Collection item-list routes derive direct membership from item
  `data.collections` and child membership from `data.parentItem`.
- `meta.numCollections` for child collection count.
- `meta.numItems`, derived from the same item JSON membership logic as
  collection item-list routes.
- Recursive collection deletion for parent collections with descendants.
- `If-Unmodified-Since-Version` precondition checks for recursive collection
  deletion.
- Moving a collection under one of its descendants breaks the cycle by moving
  that descendant to the root in memory and D1 stores.

## Known gaps

- Official `collection.test.js` has not been run against the candidate server.
