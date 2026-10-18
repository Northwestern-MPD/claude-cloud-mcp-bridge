/** Auth0 Post Login Action. Deploy this source in the selected tenant and bind it to login. */
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim(
    'https://github.com/Northwestern-MPD/claims/email_verified',
    event?.user?.email_verified === true,
  );
};
