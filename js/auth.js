// Microsoft sign-in (MSAL.js, redirect flow so it works in iPhone home-screen apps)
const SCOPES = ['User.Read', 'Files.ReadWrite'];
let pca = null;
let account = null;

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

// accountType 'personal' → only personal Microsoft accounts can sign in (work/school accounts are never offered)
export async function initAuth(clientId, accountType = 'personal') {
  const msal = window.msal;
  if (!msal) throw new Error('Sign-in library failed to load.');
  pca = new msal.PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/' + (accountType === 'work' ? 'organizations' : 'consumers'),
      redirectUri: redirectUri(),
      navigateToLoginRequestUrl: false,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();
  const r = await pca.handleRedirectPromise();
  if (r && r.account) account = r.account;
  if (!account) account = pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export const getAccount = () => account;

export function login() {
  return pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
}

export async function logout() {
  if (!pca) return;
  await pca.logoutRedirect({ account, postLogoutRedirectUri: redirectUri() });
}

let pendingRedirect = null;
export async function getToken(forceRefresh = false) {
  if (!pca || !account) throw new Error('Not signed in');
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account, forceRefresh });
    return r.accessToken;
  } catch (e) {
    if (e instanceof window.msal.InteractionRequiredAuthError || /interaction_required|login_required|consent_required/.test(e.errorCode || '')) {
      if (!pendingRedirect) pendingRedirect = pca.acquireTokenRedirect({ scopes: SCOPES, account });
      return new Promise(() => {}); // page is navigating away
    }
    throw e;
  }
}
