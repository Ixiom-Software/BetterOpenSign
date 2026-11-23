// Upstream posts the new admin's name and email to OpenSign Labs' own server
// (app.opensignlabs.com) to sign them up for its newsletter. BetterID has
// no newsletter and shares nothing with them: the sign-up page no longer
// offers it, and the cloud function does nothing for any older client.
export default async function Newsletter() {
  return 'success';
}
