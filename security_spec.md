# Security Specification for BJ Studio Client Portal

## 1. Data Invariants
- A **Project** must belong to a valid **Client**.
- An **Image** must belong to a valid **Project**.
- A **Revision** must belong to an **Image**.
- Clients can only access their own Projects, Images, and Revisions.
- Revisions are limited to 2 per Image.
- Approved Images cannot be updated with further revisions.
- Only Admins can create Clients, Projects, and upload Images.

## 2. The "Dirty Dozen" Payloads (Denial Expected)
1. Creating a client as a non-admin.
2. Accessing another client's project data by guessing the projectId.
3. Updating the `revisionCount` of an image directly without the system's logic.
4. Requesting a revision for an image that is already marked as `approved`.
5. Requesting a 3rd revision for an image (revisionCount > 2).
6. Deleting a project as a client.
7. Updating the `accessKey` of a client profile.
8. Uploading an image to someone else's project.
9. Reading the `admins` collection as a regular client.
10. Modifying the `status` of an image to `approved` if the user is not the client assigned to that project.
11. Injecting a massive string into the revision `description`.
12. Creating a revision with a fake `request.time`.

## 3. Test Runner (Draft)
A comprehensive test suite would verify these payloads against the Firestore emulator. In this environment, we will implement the rules to block these systematically.
