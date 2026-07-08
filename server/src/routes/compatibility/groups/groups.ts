import { parseNumericID, requireRoot, bytesToMegabytes, renderStorageAdminXML, parseStorageQuota, requireGroup, parseGroupUsersXML, renderGroupUsersXML, allGroupAccessNotifications, renderGroupCreateAtom, isPublicGroupRecord, getGroupVersion, groupResponse, filterGroupsForRequest, renderUserGroupsAtom, renderGroupUpdateAtom, parseGroupXML } from "../shared";
import { getRequestApiKey } from "../../../auth";
import { createKeyStore, keyAllowsGroupPermission, keyAllowsUserPermission } from "../../../keys";
import { clearMemoryCollections } from "../../../collections";
import { clearMemoryDeleted } from "../../../deleted";
import { clearMemorySearches, createSearchStore } from "../../../searches";
import { createFullTextStore } from "../../../fulltext";
import { clearMemorySettings, createSettingsStore } from "../../../settings";
import { createCompatibilityStore } from "../../../storage";
import { notificationHeaders, topicDeletedNotification } from "../../../notifications";
import { compatibility } from "../router";


compatibility.get("/users/:userID/groups", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const allGroups = await store.listVisibleGroups(userID);
  const apiKey = getRequestApiKey(c);
  const key = apiKey ? await createKeyStore(c.env).getKey(apiKey) : null;
  const visibleGroups =
    key?.userID === userID && keyAllowsUserPermission(key.access, "library")
      ? allGroups.filter(
          (group) =>
            (isPublicGroupRecord(group) && group.data.owner === userID) ||
            keyAllowsGroupPermission(key.access, group.id, "library")
        )
      : allGroups.filter(
          (group) => isPublicGroupRecord(group) && group.data.owner === userID
        );
  const groups = filterGroupsForRequest(c, visibleGroups as Array<{ data: Record<string, unknown> & { type?: string }; id: number }>);
  const headers = { "Total-Results": `${groups.length}` };

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(groups.map((group) => [group.id, getGroupVersion(group)])),
      200,
      headers
    );
  }

  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    const responseGroups = await Promise.all(
      groups.map((group) => groupResponse(c, store, group))
    );
    return c.text(renderUserGroupsAtom(responseGroups, c), 200, {
      "Content-Type": "application/atom+xml",
      ...headers,
    });
  }

  const responseGroups = await Promise.all(
    groups.map((group) => groupResponse(c, store, group))
  );
  return c.json(responseGroups, 200, headers);
});


compatibility.get("/groups", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const store = createCompatibilityStore(c.env);
  let groups = filterGroupsForRequest(
    c,
    (await store.listGroups()) as Array<{ data: Record<string, unknown> & { type?: string }; id: number }>
  );
  const q = c.req.query("q");
  if (q) {
    const populated = await Promise.all(
      groups.map(async (group) => ({
        group,
        hasItems: (await store.listGroupItems(group.id)).items.length > 0,
      }))
    );
    groups = populated.filter((entry) => entry.hasItems).map((entry) => entry.group);
  }
  const headers = { "Total-Results": `${groups.length}` };

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(groups.map((group) => [group.id, getGroupVersion(group)])),
      200,
      headers
    );
  }

  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    return c.text(renderUserGroupsAtom(groups, c), 200, {
      "Content-Type": "application/atom+xml",
      ...headers,
    });
  }

  return c.json(groups, 200, headers);
});


compatibility.get("/groups/:groupID", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const group = await store.getGroup(groupID);
  if (!group) {
    return c.text("Group not found", 404);
  }
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const response = await groupResponse(c, store, group);
  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    return c.text(renderUserGroupsAtom([response], c), 200, {
      "Content-Type": "application/atom+xml",
      "Last-Modified-Version": `${getGroupVersion(group)}`,
      "Total-Results": "1",
    });
  }

  return c.json(response, 200, {
    "Last-Modified-Version": `${getGroupVersion(group)}`,
  });
});


compatibility.put("/groups/:groupID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const group = await createCompatibilityStore(c.env).updateGroup(
    groupID,
    parseGroupXML(await c.req.text())
  );
  if (!group) {
    return c.text("Group not found", 404);
  }

  return c.text(renderGroupUpdateAtom(group), 200, {
    "Content-Type": "application/atom+xml",
    "Last-Modified-Version": `${getGroupVersion(group)}`,
  });
});


compatibility.get("/users/:userID/storageadmin", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const quota = await store.getStorageQuota(userID);
  const usageBytes = await store.getStorageUsageBytes(userID);

  return c.text(renderStorageAdminXML({ ...quota, usageBytes }), 200, {
    "Content-Type": "application/xml",
  });
});


compatibility.post("/users/:userID/storageadmin", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const params = new URLSearchParams(await c.req.text());
  const quotaValue = params.get("quota");
  const expirationValue = params.get("expiration");

  if (quotaValue === null) {
    return c.text("Quota not provided", 400);
  }
  if (expirationValue === null) {
    return c.text("Expiration not provided", 400);
  }

  const expiration = Number.parseInt(expirationValue, 10);
  if (!Number.isFinite(expiration)) {
    return c.text("Invalid expiration", 400);
  }

  let quotaInput: number | "unlimited" | null;
  try {
    quotaInput = parseStorageQuota(quotaValue);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid quota", 400);
  }

  const store = createCompatibilityStore(c.env);
  const currentUsageBytes = await store.getStorageUsageBytes(userID);
  if (
    typeof quotaInput === "number" &&
    bytesToMegabytes(currentUsageBytes) > quotaInput
  ) {
    return c.text("Cannot set quota below current usage", 409);
  }

  const quota = await store.setStorageQuota(userID, quotaInput, expiration);

  return c.text(renderStorageAdminXML({ ...quota, usageBytes: currentUsageBytes }), 200, {
    "Content-Type": "application/xml",
  });
});


compatibility.post("/groups", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const data = parseGroupXML(await c.req.text());
  const owner = typeof data.owner === "number" && Number.isFinite(data.owner) ? data.owner : 1;
  const readString = (name: string, fallback: string) =>
    typeof data[name] === "string" ? data[name] : fallback;

  const store = createCompatibilityStore(c.env);
  const group = await store.createGroup({
    description: readString("description", ""),
    fileEditing: readString("fileEditing", "none"),
    hasImage:
      typeof data.hasImage === "boolean" ||
      typeof data.hasImage === "number" ||
      typeof data.hasImage === "string"
        ? data.hasImage
        : 0,
    libraryEditing: readString("libraryEditing", "members"),
    libraryReading: readString("libraryReading", "members"),
    name: readString("name", "Test Group"),
    owner,
    type: readString("type", "Private"),
    url: readString("url", ""),
  });
  const notifications = await allGroupAccessNotifications(
    c,
    group.data.owner,
    "topicAdded",
    group.id
  );

  return c.text(renderGroupCreateAtom(group.id), 201, {
    "Content-Type": "application/atom+xml",
    Location: `${new URL(c.req.url).origin}/groups/${group.id}`,
    ...notificationHeaders(...notifications),
  });
});


compatibility.post("/groups/:groupID/users", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  let users: Array<{ role: string; userID: number }>;
  try {
    users = parseGroupUsersXML(await c.req.text(), false);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid XML", 400);
  }

  try {
    await createCompatibilityStore(c.env).addGroupUsers(groupID, users);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid role", 400);
  }
  const notifications = (
    await Promise.all(
      users.map((user) =>
        allGroupAccessNotifications(c, user.userID, "topicAdded", groupID)
      )
    )
  ).flat();

  return c.text(renderGroupUsersXML(users), 200, {
    "Content-Type": "application/atom+xml",
    ...notificationHeaders(...notifications),
  });
});


compatibility.get("/groups/:groupID/users", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const users = await createCompatibilityStore(c.env).listGroupUsers(groupID);

  return c.text(renderGroupUsersXML(users), 200, {
    "Content-Type": "application/atom+xml",
  });
});


compatibility.put("/groups/:groupID/users/:userID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  const userID = parseNumericID(c.req.param("userID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  let users: Array<{ role: string; userID: number }>;
  try {
    users = parseGroupUsersXML(await c.req.text());
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid XML", 400);
  }

  const user = users[0];
  if (!user) {
    return c.text("User not provided", 400);
  }
  if (user.userID && user.userID !== userID) {
    return c.text(`User ID ${user.userID} does not match user ID ${userID}`, 400);
  }

  try {
    await createCompatibilityStore(c.env).updateGroupUser(
      groupID,
      userID,
      user.role
    );
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid role", 400);
  }

  return c.text(renderGroupUsersXML([{ ...user, userID }]), 200, {
    "Content-Type": "application/atom+xml",
  });
});


compatibility.delete("/groups/:groupID/users/:userID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  const userID = parseNumericID(c.req.param("userID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  await createCompatibilityStore(c.env).removeGroupUser(groupID, userID);
  return c.body(null, 204, {
    ...notificationHeaders(
      ...(await allGroupAccessNotifications(c, userID, "topicRemoved", groupID))
    ),
  });
});


compatibility.delete("/groups/:groupID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  await createCompatibilityStore(c.env).deleteGroup(groupID);
  return c.body(null, 204, {
    ...notificationHeaders(topicDeletedNotification(groupID)),
  });
});


compatibility.post("/groups/:groupID/clear", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  await createCompatibilityStore(c.env).clearGroupLibrary(groupID);
  await createFullTextStore(c.env).clearFullText("group", groupID);
  await createSearchStore(c.env).clearSearches("group", groupID);
  await createSettingsStore(c.env).clearSettings("group", groupID);
  clearMemoryCollections("group", groupID);
  clearMemoryDeleted("group", groupID);
  clearMemorySearches("group", groupID);
  clearMemorySettings("group", groupID);
  return c.body(null, 204);
});


compatibility.post("/users/:userID/clear", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  await createCompatibilityStore(c.env).clearUserLibrary(userID);
  await createFullTextStore(c.env).clearFullText("user", userID);
  await createSearchStore(c.env).clearSearches("user", userID);
  await createSettingsStore(c.env).clearSettings("user", userID);
  clearMemoryCollections("user", userID);
  clearMemoryDeleted("user", userID);
  clearMemorySearches("user", userID);
  clearMemorySettings("user", userID);
  return c.body(null, 204);
});
