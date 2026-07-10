export const parseGroupUsersXML = (
  body: string,
  requireID = true
): Array<{ role: string; userID: number }> => {
  const users: Array<{ role: string; userID: number }> = [];
  const userPattern = /<user\b([^/>]*)\/?>/g;

  for (const match of body.matchAll(userPattern)) {
    const attrs = match[1] ?? "";
    const id = attrs.match(/\bid="([^"]*)"/)?.[1];
    const role = attrs.match(/\brole="([^"]*)"/)?.[1];

    if (!(id || !requireID)) {
      throw new Error("User ID not provided");
    }
    if (!role) {
      throw new Error("Role not provided");
    }

    const userID = id ? Number.parseInt(id, 10) : 0;
    if (id && !Number.isFinite(userID)) {
      throw new Error("Invalid user ID");
    }

    users.push({ role, userID });
  }

  return users;
};

export const renderGroupUsersXML = (
  users: Array<{ role: string; userID: number }>
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    ...users.map(
      (user) =>
        `<entry><title>User ${user.userID}</title><content type="application/xml"><user id="${user.userID}" role="${user.role}"/></content></entry>`
    ),
    "</feed>",
  ].join("");
