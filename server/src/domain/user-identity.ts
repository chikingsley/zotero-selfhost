const userIdentities = new Map<
  number,
  { displayName: string; username: string }
>();

export const registerUserIdentity = (
  userID: number,
  username: string,
  displayName: string
) => {
  userIdentities.set(userID, { displayName, username });
};

export const getUserIdentity = (userID: number) =>
  userIdentities.get(userID) ??
  (userID === 1
    ? { displayName: "Real Name", username: "phpunit" }
    : userID === 2
      ? { displayName: "Real Name 2", username: "phpunit2" }
      : {
          displayName: `User ${userID}`,
          username: `user${userID}`,
        });
