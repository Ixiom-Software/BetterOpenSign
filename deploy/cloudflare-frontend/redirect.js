// The docsign Worker: serves the built app (the ASSETS binding) and 301s the
// site's old name, docsign.bettersign.ing, to docsign.betterid.net with the
// same path and query. A Worker rather than a zone Redirect Rule so it ships
// with the site (DEPLOYMENT.md, "Moving to docsign.betterid.net").
const OLD_HOST = "docsign.bettersign.ing";
const NEW_HOST = "docsign.betterid.net";
// Emails sent before the rename load the logo from its old file name.
const OLD_LOGO_PATH = "/bettersign-logo.png";
const NEW_LOGO_PATH = "/betterid-logo.png";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oldLogo = url.pathname === OLD_LOGO_PATH;
    if (url.hostname === OLD_HOST || oldLogo) {
      url.hostname = NEW_HOST;
      if (oldLogo) url.pathname = NEW_LOGO_PATH;
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  }
};
