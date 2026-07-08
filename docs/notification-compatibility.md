# Zotero notification compatibility

## Current implementation

- Mutation responses can include the debug `zotero-debug-notifications` header in the same base64 JSON-string array format used by Zotero's official remote tests.
- User and group item create/update/delete responses emit `topicUpdated` notifications.
- API key group-access changes emit `topicAdded` and `topicRemoved` notifications for affected group topics.
- Group creation emits `topicAdded` notifications for the owner's keys with all-group access.
- Group deletion emits a `topicDeleted` notification.
- Group member add/remove operations emit `topicAdded` and `topicRemoved` notifications for that user's keys with all-group access.

## Known gaps

- The official notification remote-test slice has not been run against this Worker.
- This is a local debug-header implementation, not an SNS/Redis fan-out service.
- Notification coverage is focused on the official mutation cases currently visible in `notifications.test.js`; broader real-time subscription delivery is not implemented.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/notifications.test.js`
