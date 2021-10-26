/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { classes: Cc, interfaces: Ci, results: Cr, utils: Cu } = Components;

const { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { PrivateBrowsingUtils } = ChromeUtils.import("resource://gre/modules/PrivateBrowsingUtils.jsm");
const { PromptUtils } = ChromeUtils.import("resource://gre/modules/SharedPromptUtils.jsm", {});

XPCOMUtils.defineLazyModuleGetter(this, "LoginHelper",
                                  "resource://gre/modules/LoginHelper.jsm");

Services.scriptloader.loadSubScript("chrome://embedlite/content/Logger.js");

const LoginInfo =
      Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
                             "nsILoginInfo", "init");

const BRAND_BUNDLE = "chrome://branding/locale/brand.properties";

/**
 * Constants for password prompt telemetry.
 * Mirrored in mobile/android/components/LoginManagerPrompter.js */
const PROMPT_DISPLAYED = 0;

const PROMPT_ADD_OR_UPDATE = 1;
const PROMPT_NOTNOW = 2;
const PROMPT_NEVER = 3;

/**
 * Implements nsIPromptFactory
 *
 * Invoked by [toolkit/components/prompts/src/nsPrompter.js]
 */
function LoginManagerPromptFactory() {
  Logger.debug("JSComp: LoginManagerPromptFactory loaded");

  Services.obs.addObserver(this, "quit-application-granted", true);
  Services.obs.addObserver(this, "passwordmgr-crypto-login", true);
  Services.obs.addObserver(this, "passwordmgr-crypto-loginCanceled", true);
}

LoginManagerPromptFactory.prototype = {

  classID : Components.ID("{72de694e-6c88-11e2-a4ee-6b515bdf0cb7}"),
  QueryInterface : ChromeUtils.generateQI([Ci.nsIPromptFactory, Ci.nsIObserver, Ci.nsISupportsWeakReference]),

  _asyncPrompts : {},
  _asyncPromptInProgress : false,

  observe : function (subject, topic, data) {
    this.log("Observed: " + topic);
    if (topic == "quit-application-granted") {
      this._cancelPendingPrompts();
    } else if (topic == "passwordmgr-crypto-login") {
      // Start processing the deferred prompters.
      this._doAsyncPrompt();
    } else if (topic == "passwordmgr-crypto-loginCanceled") {
      // User canceled a Master Password prompt, so go ahead and cancel
      // all pending auth prompts to avoid nagging over and over.
      this._cancelPendingPrompts();
    }
  },

  getPrompt : function (aWindow, aIID) {
    var prompt = new LoginManagerPrompter().QueryInterface(aIID);
    prompt.init(aWindow, this);
    return prompt;
  },

  _doAsyncPrompt : function() {
    if (this._asyncPromptInProgress) {
      this.log("_doAsyncPrompt bypassed, already in progress");
      return;
    }

    // Find the first prompt key we have in the queue
    var hashKey = null;
    for (hashKey in this._asyncPrompts)
      break;

    if (!hashKey) {
      this.log("_doAsyncPrompt:run bypassed, no prompts in the queue");
      return;
    }

    // If login manger has logins for this host, defer prompting if we're
    // already waiting on a master password entry.
    var prompt = this._asyncPrompts[hashKey];
    var prompter = prompt.prompter;
    var [hostname, httpRealm] = prompter._getAuthTarget(prompt.channel, prompt.authInfo);
    var hasLogins = (prompter._pwmgr.countLogins(hostname, null, httpRealm) > 0);
    if (!hasLogins && LoginHelper.schemeUpgrades && hostname.startsWith("https://")) {
      let httpHostname = hostname.replace(/^https:\/\//, "http://");
      hasLogins = (prompter._pwmgr.countLogins(httpHostname, null, httpRealm) > 0);
    }
    if (hasLogins && prompter._pwmgr.uiBusy) {
      this.log("_doAsyncPrompt:run bypassed, master password UI busy");
      return;
    }

    // Allow only a limited number of authentication dialogs when they are all
    // canceled by the user.
    var cancelationCounter = (prompter._browser && prompter._browser.canceledAuthenticationPromptCounter) || { count: 0, id: 0 };
    if (prompt.channel) {
      var httpChannel = prompt.channel.QueryInterface(Ci.nsIHttpChannel);
      if (httpChannel) {
        var windowId = httpChannel.topLevelContentWindowId;
        if (windowId != cancelationCounter.id) {
          // window has been reloaded or navigated, reset the counter
          cancelationCounter = { count: 0, id: windowId };
        }
      }
    }

    var self = this;

    var runnable = {
      cancel: false,
      run : function() {
        var ok = false;
        if (!this.cancel) {
          try {
            self.log("_doAsyncPrompt:run - performing the prompt for '" + hashKey + "'");
            ok = prompter.promptAuth(prompt.channel,
                                     prompt.level,
                                     prompt.authInfo);
          } catch (e) {
            if (e instanceof Components.Exception &&
                e.result == Cr.NS_ERROR_NOT_AVAILABLE) {
              self.log("_doAsyncPrompt:run bypassed, UI is not available in this context");
            } else {
              Components.utils.reportError("LoginManagerPrompter: " +
                                           "_doAsyncPrompt:run: " + e + "\n");
            }
          }

          delete self._asyncPrompts[hashKey];
          prompt.inProgress = false;
          self._asyncPromptInProgress = false;

          if (ok) {
            cancelationCounter.count = 0;
          } else {
            cancelationCounter.count++;
          }
          if (prompter._browser) {
            prompter._browser.canceledAuthenticationPromptCounter = cancelationCounter;
          }
        }

        for (var consumer of prompt.consumers) {
          if (!consumer.callback)
            // Not having a callback means that consumer didn't provide it
            // or canceled the notification
            continue;

          self.log("Calling back to " + consumer.callback + " ok=" + ok);
          try {
            if (ok) {
              consumer.callback.onAuthAvailable(consumer.context, prompt.authInfo);
            } else {
              consumer.callback.onAuthCancelled(consumer.context, !this.cancel);
            }
          } catch (e) { /* Throw away exceptions caused by callback */ }
        }
        self._doAsyncPrompt();
      }
    };

    var cancelDialogLimit = Services.prefs.getIntPref("prompts.authentication_dialog_abuse_limit");

    this.log("cancelationCounter =", cancelationCounter);
    if (cancelDialogLimit && cancelationCounter.count >= cancelDialogLimit) {
      this.log("Blocking auth dialog, due to exceeding dialog bloat limit");
      delete this._asyncPrompts[hashKey];

      // just make the runnable cancel all consumers
      runnable.cancel = true;
    } else {
      this._asyncPromptInProgress = true;
      prompt.inProgress = true;
    }

    Services.tm.mainThread.dispatch(runnable, Ci.nsIThread.DISPATCH_NORMAL);
    this.log("_doAsyncPrompt:run dispatched");
  },


  _cancelPendingPrompts : function() {
    this.log("Canceling all pending prompts...");
    var asyncPrompts = this._asyncPrompts;
    this.__proto__._asyncPrompts = {};

    for (var hashKey in asyncPrompts) {
      let prompt = asyncPrompts[hashKey];
      // Watch out! If this prompt is currently prompting, let it handle
      // notifying the callbacks of success/failure, since it's already
      // asking the user for input. Reusing a callback can be crashy.
      if (prompt.inProgress) {
        this.log("skipping a prompt in progress");
        continue;
      }

      for (var consumer of prompt.consumers) {
        if (!consumer.callback)
          continue;

        this.log("Canceling async auth prompt callback " + consumer.callback);
        try {
          consumer.callback.onAuthCancelled(consumer.context, true);
        } catch (e) { /* Just ignore exceptions from the callback */ }
      }
    }
  },
}; // end of LoginManagerPromptFactory implementation

XPCOMUtils.defineLazyGetter(this.LoginManagerPromptFactory.prototype, "log", () => {
  let logger = LoginHelper.createLogger("Login PromptFactory");
  return logger.log.bind(logger);
});




/* ==================== LoginManagerPrompter ==================== */




/**
 * Implements interfaces for prompting the user to enter/save/change auth info.
 *
 * nsIAuthPrompt: Used by SeaMonkey, Thunderbird, but not Firefox.
 *
 * nsIAuthPrompt2: Is invoked by a channel for protocol-based authentication
 * (eg HTTP Authenticate, FTP login).
 *
 * nsILoginManagerPrompter: Used by Login Manager for saving/changing logins
 * found in HTML forms.
 */
function LoginManagerPrompter() {
  Logger.debug("JSComp: LoginManagerPrompter.js loaded");
}

LoginManagerPrompter.prototype = {

  classID : Components.ID("{8aa66d77-1bbb-45a6-991e-b8f47751c291}"),
  QueryInterface : ChromeUtils.generateQI([Ci.nsIAuthPrompt,
                                           Ci.nsIAuthPrompt2,
                                           Ci.nsILoginManagerPrompter,
                                           Ci.nsIEmbedMessageListener]),

  _factory       : null,
  _chromeWindow  : null,
  _browser       : null,
  _opener        : null,
  _pendingRequests: {},

  _getRandomId: function() {
    let idService = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
    return idService.generateUUID().toString();
  },

  __pwmgr : null, // Password Manager service
  get _pwmgr() {
    if (!this.__pwmgr)
      this.__pwmgr = Cc["@mozilla.org/login-manager;1"].
                     getService(Ci.nsILoginManager);
    return this.__pwmgr;
  },

  __promptService : null, // Prompt service for user interaction
  get _promptService() {
    if (!this.__promptService)
      this.__promptService =
          Cc["@mozilla.org/embedcomp/prompt-service;1"].
          getService(Ci.nsIPromptService);
    return this.__promptService;
  },


  __strBundle : null, // String bundle for L10N
  get _strBundle() {
    if (!this.__strBundle) {
      var bunService = Cc["@mozilla.org/intl/stringbundle;1"].
                       getService(Ci.nsIStringBundleService);
      this.__strBundle = bunService.createBundle(
                  "chrome://passwordmgr/locale/passwordmgr.properties");
      if (!this.__strBundle)
        throw new Error("String bundle for Login Manager not present!");
    }

    return this.__strBundle;
  },


  __ellipsis : null,
  get _ellipsis() {
    if (!this.__ellipsis) {
      this.__ellipsis = "\u2026";
      try {
        this.__ellipsis = Services.prefs.getComplexValue(
                            "intl.ellipsis", Ci.nsIPrefLocalizedString).data;
      } catch (e) { }
    }
    return this.__ellipsis;
  },


  // Whether we are in private browsing mode
  get _inPrivateBrowsing() {
    if (this._chromeWindow) {
      return PrivateBrowsingUtils.isContentWindowPrivate(this._chromeWindow);
    }
    // If we don't that we're in private browsing mode if the caller did
    // not provide a window.  The callers which really care about this
    // will indeed pass down a window to us, and for those who don't,
    // we can just assume that we don't want to save the entered login
    // information.
    this.log("We have no chromeWindow so assume we're in a private context");
    return true;
  },




  /* ---------- nsIAuthPrompt prompts ---------- */


  /**
   * Wrapper around the prompt service prompt. Saving random fields here
   * doesn't really make sense and therefore isn't implemented.
   */
  prompt : function (aDialogTitle, aText, aPasswordRealm,
                     aSavePassword, aDefaultText, aResult) {
    if (aSavePassword != Ci.nsIAuthPrompt.SAVE_PASSWORD_NEVER)
      throw new Components.Exception("prompt only supports SAVE_PASSWORD_NEVER",
                                     Cr.NS_ERROR_NOT_IMPLEMENTED);

    this.log("===== prompt() called =====");

    if (aDefaultText) {
      aResult.value = aDefaultText;
    }

    return this._promptService.prompt(this._chromeWindow,
           aDialogTitle, aText, aResult, null, {});
  },


  /**
   * Looks up a username and password in the database. Will prompt the user
   * with a dialog, even if a username and password are found.
   */
  promptUsernameAndPassword : function (aDialogTitle, aText, aPasswordRealm,
                                       aSavePassword, aUsername, aPassword) {
    this.log("===== promptUsernameAndPassword() called =====");

    if (aSavePassword == Ci.nsIAuthPrompt.SAVE_PASSWORD_FOR_SESSION)
      throw new Components.Exception("promptUsernameAndPassword doesn't support SAVE_PASSWORD_FOR_SESSION",
                                     Cr.NS_ERROR_NOT_IMPLEMENTED);

    var selectedLogin = null;
    var checkBox = { value : false };
    var checkBoxLabel = null;
    var [hostname, realm, unused] = this._getRealmInfo(aPasswordRealm);

    // If hostname is null, we can't save this login.
    if (hostname) {
      var canRememberLogin;
      if (this._inPrivateBrowsing)
        canRememberLogin = false;
      else
        canRememberLogin = (aSavePassword ==
                            Ci.nsIAuthPrompt.SAVE_PASSWORD_PERMANENTLY) &&
                           this._pwmgr.getLoginSavingEnabled(hostname);

      // if checkBoxLabel is null, the checkbox won't be shown at all.
      if (canRememberLogin)
        checkBoxLabel = "rememberPassword";

      // Look for existing logins.
      var foundLogins = this._pwmgr.findLogins({}, hostname, null,
                                  realm);

      // XXX Like the original code, we can't deal with multiple
      // account selection. (bug 227632)
      if (foundLogins.length > 0) {
        selectedLogin = foundLogins[0];

        // If the caller provided a username, try to use it. If they
        // provided only a password, this will try to find a password-only
        // login (or return null if none exists).
        if (aUsername.value)
          selectedLogin = this._repickSelectedLogin(foundLogins,
                                                    aUsername.value);

        if (selectedLogin) {
          checkBox.value = true;
          aUsername.value = selectedLogin.username;
          // If the caller provided a password, prefer it.
          if (!aPassword.value)
            aPassword.value = selectedLogin.password;
        }
      }
    }

    var ok = this._promptService.promptUsernameAndPassword(this._chromeWindow,
                aDialogTitle, aText, aUsername, aPassword,
                checkBoxLabel, checkBox);

    if (!ok || !checkBox.value || !hostname)
      return ok;

    if (!aPassword.value) {
      this.log("No password entered, so won't offer to save.");
      return ok;
    }

    // XXX We can't prompt with multiple logins yet (bug 227632), so
    // the entered login might correspond to an existing login
    // other than the one we originally selected.
    selectedLogin = this._repickSelectedLogin(foundLogins, aUsername.value);

    // If we didn't find an existing login, or if the username
    // changed, save as a new login.
    let newLogin = Cc["@mozilla.org/login-manager/loginInfo;1"].
                   createInstance(Ci.nsILoginInfo);
    newLogin.init(hostname, null, realm,
                  aUsername.value, aPassword.value, "", "");
    if (!selectedLogin) {
      // add as new
      this.log("New login seen for " + realm);
      this._pwmgr.addLogin(newLogin);
    } else if (aPassword.value != selectedLogin.password) {
      // update password
      this.log("Updating password for  " + realm);
      this._updateLogin(selectedLogin, newLogin);
    } else {
      this.log("Login unchanged, no further action needed.");
      this._updateLogin(selectedLogin);
    }

    return ok;
  },


  /**
   * If a password is found in the database for the password realm, it is
   * returned straight away without displaying a dialog.
   *
   * If a password is not found in the database, the user will be prompted
   * with a dialog with a text field and ok/cancel buttons. If the user
   * allows it, then the password will be saved in the database.
   */
  promptPassword : function (aDialogTitle, aText, aPasswordRealm,
                             aSavePassword, aPassword) {
    this.log("===== promptPassword called() =====");

    if (aSavePassword == Ci.nsIAuthPrompt.SAVE_PASSWORD_FOR_SESSION)
      throw new Components.Exception("promptPassword doesn't support SAVE_PASSWORD_FOR_SESSION",
                                     Cr.NS_ERROR_NOT_IMPLEMENTED);

    var checkBox = { value : false };
    var checkBoxLabel = null;
    var [hostname, realm, username] = this._getRealmInfo(aPasswordRealm);

    username = decodeURIComponent(username);

    // If hostname is null, we can't save this login.
    if (hostname && !this._inPrivateBrowsing) {
      var canRememberLogin = (aSavePassword ==
                              Ci.nsIAuthPrompt.SAVE_PASSWORD_PERMANENTLY) &&
                             this._pwmgr.getLoginSavingEnabled(hostname);

      // if checkBoxLabel is null, the checkbox won't be shown at all.
      if (canRememberLogin)
        checkBoxLabel = "rememberPassword";

      if (!aPassword.value) {
        // Look for existing logins.
        var foundLogins = this._pwmgr.findLogins({}, hostname, null,
                                          realm);

        // XXX Like the original code, we can't deal with multiple
        // account selection (bug 227632). We can deal with finding the
        // account based on the supplied username - but in this case we'll
        // just return the first match.
        for (var i = 0; i < foundLogins.length; ++i) {
          if (foundLogins[i].username == username) {
            aPassword.value = foundLogins[i].password;
            // wallet returned straight away, so this mimics that code
            return true;
          }
        }
      }
    }

    var ok = this._promptService.promptPassword(this._chromeWindow, aDialogTitle,
                                                aText, aPassword,
                                                checkBoxLabel, checkBox);

    if (ok && checkBox.value && hostname && aPassword.value) {
      var newLogin = Cc["@mozilla.org/login-manager/loginInfo;1"].
                     createInstance(Ci.nsILoginInfo);
      newLogin.init(hostname, null, realm, username,
                    aPassword.value, "", "");

      this.log("New login seen for " + realm);

      this._pwmgr.addLogin(newLogin);
    }

    return ok;
  },

  /* ---------- nsIAuthPrompt helpers ---------- */


  /**
   * Given aRealmString, such as "http://user@example.com/foo", returns an
   * array of:
   *   - the formatted hostname
   *   - the realm (hostname + path)
   *   - the username, if present
   *
   * If aRealmString is in the format produced by NS_GetAuthKey for HTTP[S]
   * channels, e.g. "example.com:80 (httprealm)", null is returned for all
   * arguments to let callers know the login can't be saved because we don't
   * know whether it's http or https.
   */
  _getRealmInfo : function (aRealmString) {
    var httpRealm = /^.+ \(.+\)$/;
    if (httpRealm.test(aRealmString))
      return [null, null, null];

    var uri = Services.io.newURI(aRealmString, null, null);
    var pathname = "";

    if (uri.path != "/")
      pathname = uri.path;

    var formattedHostname = this._getFormattedHostname(uri);

    return [formattedHostname, formattedHostname + pathname, uri.username];
  },

  /* ---------- nsIAuthPrompt2 prompts ---------- */




  /**
   * Implementation of nsIAuthPrompt2.
   *
   * @param {nsIChannel} aChannel
   * @param {int}        aLevel
   * @param {nsIAuthInformation} aAuthInfo
   */
  promptAuth : function (aChannel, aLevel, aAuthInfo) {
    var selectedLogin = null;
    var checkbox = { value : false };
    var checkboxLabel = null;
    var epicfail = false;
    var canAutologin = false;
    var notifyObj;
    var foundLogins;

    try {
      this.log("===== promptAuth called =====");

      // If the user submits a login but it fails, we need to remove the
      // notification bar that was displayed. Conveniently, the user will
      // be prompted for authentication again, which brings us here.
      this._removeLoginNotifications();

      var [hostname, httpRealm] = this._getAuthTarget(aChannel, aAuthInfo);

      // Looks for existing logins to prefill the prompt with.
      foundLogins = LoginHelper.searchLoginsWithObject({
        hostname,
        httpRealm,
        schemeUpgrades: LoginHelper.schemeUpgrades,
      });
      this.log("found", foundLogins.length, "matching logins.");
      let resolveBy = [
        "scheme",
        "timePasswordChanged",
      ];
      foundLogins = LoginHelper.dedupeLogins(foundLogins, ["username"], resolveBy, hostname);
      this.log(foundLogins.length, "matching logins remain after deduping");

      // XXX Can't select from multiple accounts yet. (bug 227632)
      if (foundLogins.length > 0) {
        selectedLogin = foundLogins[0];
        this._SetAuthInfo(aAuthInfo, selectedLogin.username,
                                     selectedLogin.password);

        // Allow automatic proxy login
        if (aAuthInfo.flags & Ci.nsIAuthInformation.AUTH_PROXY &&
            !(aAuthInfo.flags & Ci.nsIAuthInformation.PREVIOUS_FAILED) &&
            Services.prefs.getBoolPref("signon.autologin.proxy") &&
            !this._inPrivateBrowsing) {

          this.log("Autologin enabled, skipping auth prompt.");
          canAutologin = true;
        }

        checkbox.value = true;
      }

      var canRememberLogin = this._pwmgr.getLoginSavingEnabled(hostname);
      if (this._inPrivateBrowsing)
        canRememberLogin = false;

      // if checkboxLabel is null, the checkbox won't be shown at all.
      notifyObj = this._getPopupNote() || this._getNotifyBox();
      if (canRememberLogin && !notifyObj)
        checkboxLabel = "rememberPassword";
    } catch (e) {
      // Ignore any errors and display the prompt anyway.
      epicfail = true;
      Components.utils.reportError("LoginManagerPrompter: " +
          "Epic fail in promptAuth: " + e + "\n");
    }

    var ok = canAutologin;
    if (!ok) {
      if (this._chromeWindow)
        PromptUtils.fireDialogEvent(this._chromeWindow, "DOMWillOpenModalDialog", this._browser);
      ok = this._promptService.promptAuth(this._chromeWindow,
                                          aChannel, aLevel, aAuthInfo,
                                          checkboxLabel, checkbox);
    }

    // If there's a notification box, use it to allow the user to
    // determine if the login should be saved. If there isn't a
    // notification box, only save the login if the user set the
    // checkbox to do so.
    var rememberLogin = notifyObj ? canRememberLogin : checkbox.value;
    if (!ok || !rememberLogin || epicfail)
      return ok;

    try {
      var [username, password] = this._GetAuthInfo(aAuthInfo);

      if (!password) {
        this.log("No password entered, so won't offer to save.");
        return ok;
      }

      // XXX We can't prompt with multiple logins yet (bug 227632), so
      // the entered login might correspond to an existing login
      // other than the one we originally selected.
      selectedLogin = this._repickSelectedLogin(foundLogins, username);

      // If we didn't find an existing login, or if the username
      // changed, save as a new login.
      let newLogin = Cc["@mozilla.org/login-manager/loginInfo;1"].
                     createInstance(Ci.nsILoginInfo);
      newLogin.init(hostname, null, httpRealm,
                    username, password, "", "");
      if (!selectedLogin) {
        this.log("New login seen for " + username +
                 " @ " + hostname + " (" + httpRealm + ")");

        if (notifyObj)
          this._showSaveLoginNotification(this._chromeWindow, newLogin);
        else
          this._pwmgr.addLogin(newLogin);
      } else if (password != selectedLogin.password) {
        this.log("Updating password for " + username +
                 " @ " + hostname + " (" + httpRealm + ")");
        if (notifyObj)
          this._showChangeLoginNotification(this._chromeWindow, selectedLogin, newLogin);
        else
          this._updateLogin(selectedLogin, newLogin);
      } else {
        this.log("Login unchanged, no further action needed.");
        this._updateLogin(selectedLogin);
      }
    } catch (e) {
      Components.utils.reportError("LoginManagerPrompter: " +
          "Fail2 in promptAuth: " + e + "\n");
    }

    return ok;
  },

  asyncPromptAuth : function (aChannel, aCallback, aContext, aLevel, aAuthInfo) {
    var cancelable = null;

    try {
      this.log("===== asyncPromptAuth called =====");

      // If the user submits a login but it fails, we need to remove the
      // notification bar that was displayed. Conveniently, the user will
      // be prompted for authentication again, which brings us here.
      this._removeLoginNotifications();

      cancelable = this._newAsyncPromptConsumer(aCallback, aContext);

      var [hostname, httpRealm] = this._getAuthTarget(aChannel, aAuthInfo);

      var hashKey = aLevel + "|" + hostname + "|" + httpRealm;
      this.log("Async prompt key = " + hashKey);
      var asyncPrompt = this._factory._asyncPrompts[hashKey];
      if (asyncPrompt) {
        this.log("Prompt bound to an existing one in the queue, callback = " + aCallback);
        asyncPrompt.consumers.push(cancelable);
        return cancelable;
      }

      this.log("Adding new prompt to the queue, callback = " + aCallback);
      asyncPrompt = {
        consumers: [cancelable],
        channel: aChannel,
        authInfo: aAuthInfo,
        level: aLevel,
        inProgress : false,
        prompter: this
      };

      this._factory._asyncPrompts[hashKey] = asyncPrompt;
      this._factory._doAsyncPrompt();
    } catch (e) {
      Components.utils.reportError("LoginManagerPrompter: " +
          "asyncPromptAuth: " + e + "\nFalling back to promptAuth\n");
      // Fail the prompt operation to let the consumer fall back
      // to synchronous promptAuth method
      throw e;
    }

    return cancelable;
  },




  /* ---------- nsILoginManagerPrompter prompts ---------- */


  init : function (aWindow = null, aFactory = null) {
    this._chromeWindow = aWindow;
    this._opener = null;
    this._factory = aFactory || null;

    this.log("JSComp: nsLoginManagerPrompter initialized");
  },

  set browser(aBrowser) {
    this._browser = aBrowser;
  },

  set opener(aOpener) {
    this._opener = aOpener;
  },

  /**
   * Ask the user if they want to save a login (Yes, Never, Not Now)
   *
   * @param aBrowser
   *        The browser of the webpage request that triggered the prompt.
   * @param aLogin
   *        The login to be saved.
   * @param dismissed (optional)
   *        A boolean value indicating whether the save logins doorhanger should
   *        be dismissed automatically when shown.
   * @param notifySaved (optional)
   *        A boolean value indicating whether the notification should indicate that
   *        a login has been saved
   * @param autoFilledLoginGuid (optional)
   *        A string guid value for the login which was autofilled into the form
   */
  promptToSavePassword : function (aBrowser, aLogin) {
    this.log("promptToSavePassword");
    this._showSaveLoginNotification(aBrowser, aLogin);
  },

  /**
   * Ask the user if they want to change a login's password or username.
   * If the user consents, modifyLogin() will be called.
   *
   * @param aBrowser
   *        The browser of the webpage request that triggered the prompt.
   * @param aOldLogin
   *        The existing login (with the old password).
   * @param aNewLogin
   *        The new login.
   * @param dismissed (optional)
   *        A boolean value indicating whether the save logins doorhanger should
   *        be dismissed automatically when shown.
   * @param notifySaved (optional)
   *        A boolean value indicating whether the notification should indicate that
   *        a login has been saved
   * @param autoSavedLoginGuid (optional)
   *        A string guid value for the old login to be removed if the changes
   *        match it to a different login
   * @param autoFilledLoginGuid (optional)
   *        A string guid value for the login which was autofilled into the form
   */
  promptToChangePassword(aBrowser, aOldLogin, aNewLogin) {
    this.log("promptToChangePassword");
    this._showChangeLoginNotification(aBrowser, aOldLogin, aNewLogin);
  },

  /**
   * Ask the user if they want to change the password for one of
   * multiple logins, when the caller can't determine exactly which
   * login should be changed. If the user consents, modifyLogin() will
   * be called.
   *
   * @param aBrowser
   *        The browser of the webpage request that triggered the prompt.
   * @param logins
   *        An array of existing logins.
   * @param aNewLogin
   *        The new login.
   *
   * Note: Because the caller does not know the username of the login
   *       to be changed, aNewLogin.username and aNewLogin.usernameField
   *       will be set (using the user's selection) before modifyLogin()
   *       is called.
   *
   * Note: XPCOM stupidity: |count| is just |logins.length|.
   */
  promptToChangePasswordWithUsernames : function (aBrowser, logins, count, aNewLogin) {
    this.log("promptToChangePasswordWithUsernames");
    this._showChangeLoginWithUsernamesNotification(aBrowser, logins, aNewLogin);
  },

  onMessageReceived: function(messageName, message) {
    this.log("nsLoginManagerPrompter.js on message received: top:", messageName, ", msg:", message);
    var ret = JSON.parse(message);
    // Send Request
    if (!ret.id) {
      this.warn("nsLoginManagerPrompter.js: Request id not defined in response");
      return;
    }
    let request = this._pendingRequests[ret.id];
    if (!request) {
      this.warn("nsLoginManagerPrompter.js: Wrong request id:", ret.id);
      return;
    }
    let selectedIndex = ret.selectedIndex || 0;
    request[ret.buttonidx].callback(ret.buttonidx, selectedIndex);
    Services.embedlite.removeMessageListener("embedui:login", this);
    delete this._pendingRequests[ret.id];
  },

  /* ---------- Internal Methods ---------- */

  /**
   * Displays a notification bar.
   */
  _showLoginNotification : function (aBrowser, aName, aTextBundle, aButtons, aFormData) {
    this.log("Adding new " + aName + " notification bar");

    this._chromeWindow = aBrowser;
    let notifyWin = this._chromeWindow && this._chromeWindow.top || null;

    // The page we're going to hasn't loaded yet, so we want to persist
    // across the first location change.
    let logoptions = {
      persistWhileVisible: true,
      timeout: Date.now() + 10000
    }

    Services.embedlite.addMessageListener("embedui:login", this);
    try {
      var winid = Services.embedlite.getIDByWindow(notifyWin);
      let uniqueid = this._getRandomId();
      Services.embedlite.sendAsyncMessage(winid, "embed:login",
                                          JSON.stringify({
                                                           name: aName,
                                                           textBundle: aTextBundle,
                                                           buttons: aButtons,
                                                           options: logoptions,
                                                           id: uniqueid,
                                                           formdata: aFormData
                                                         }));
      this._pendingRequests[uniqueid] = aButtons;
    } catch (e) {
      Logger.warn("nsLoginManagerPrompter: sending async message failed", e)
    }
  },

  /**
   * Displays a notification bar or a popup notification, to allow the user
   * to save the specified login. This allows the user to see the results of
   * their login, and only save a login which they know worked.
   *
   * @param aLogin
   *        The login captured from the form.
   */
  _showSaveLoginNotification : function (aBrowser, aLogin) {
    var displayHost = this._getShortDisplayHost(aLogin.hostname);
    var notificationTextBundle = ["rememberPasswordMsgNoUsername", displayHost];
    var formData = {
      "displayHost": displayHost
    };
    if (aLogin.username) {
      var displayUser = this._sanitizeUsername(aLogin.username);
      formData["displayUser"] = displayUser;
      notificationTextBundle = ["rememberPasswordMsg", displayUser, displayHost];
    }

    // The callbacks in |buttons| have a closure to access the variables
    // in scope here; set one to |this._pwmgr| so we can get back to pwmgr
    // without a getService() call.
    var pwmgr = this._pwmgr;

    var buttons = [
      // "Remember" button
      {
        label:     "notifyBarRememberPasswordButtonText",
        accessKey: "notifyBarRememberPasswordButtonAccessKey",
        popup:     null,
        callback: function(aButton) {
          pwmgr.addLogin(aLogin);
        }
      },

      // "Never for this site" button
      {
        label:     "notifyBarNeverRememberButtonText",
        accessKey: "notifyBarNeverRememberButtonAccessKey",
        popup:     null,
        callback: function(aButton) {
          pwmgr.setLoginSavingEnabled(aLogin.hostname, false);
        }
      },

      // "Not now" button
      {
        label:     "notifyBarNotNowButtonText",
        accessKey: "notifyBarNotNowButtonAccessKey",
        popup:     null,
        callback:  function() { /* NOP */ }
      }
    ];

    this._showLoginNotification(aBrowser, "password-save", notificationTextBundle,
                                buttons, formData);

    Services.obs.notifyObservers(aLogin, "passwordmgr-prompt-save", null);
  },

  _removeLoginNotifications : function () {
    var popupNote = this._getPopupNote();
    if (popupNote)
      popupNote = popupNote.getNotification("password");
    if (popupNote)
      popupNote.remove();

    var notifyBox = this._getNotifyBox();
    if (notifyBox) {
      var oldBar = notifyBox.getNotificationWithValue("password-save");
      if (oldBar) {
        this.log("Removing save-password notification bar.");
        notifyBox.removeNotification(oldBar);
      }

      oldBar = notifyBox.getNotificationWithValue("password-change");
      if (oldBar) {
        this.log("Removing change-password notification bar.");
        notifyBox.removeNotification(oldBar);
      }
    }
  },

  /**
   * Shows the Change Password notification bar or popup notification.
   *
   * @param aBrowser
   *        The browser of the webpage request that triggered the prompt.
   * @param aOldLogin
   *        The stored login we want to update.
   * @param aNewLogin
   *        The login object with the changes we want to make.
   */
  _showChangeLoginNotification(aBrowser, aOldLogin, aNewLogin) {
    // We reuse the existing message, even if it expects a username, until we
    // switch to the final terminology in bug 1144856.
    var displayHost = this._getShortDisplayHost(aOldLogin.hostname);
    var notificationTextBundle;
    var formData = {
      "displayHost": displayHost
    };
    if (aOldLogin.username) {
      var displayUser = this._sanitizeUsername(aOldLogin.username);
      notificationTextBundle = ["updatePasswordMsg", displayUser];
      formData["displayUser"] = displayUser;
    } else {
      notificationTextBundle = ["updatePasswordMsgNoUser"];
    }

    // The callbacks in |buttons| have a closure to access the variables
    // in scope here; set one to |this._pwmgr| so we can get back to pwmgr
    // without a getService() call.
    var self = this;

    var buttons = [
      // "Yes" button
      {
        label:     "notifyBarUpdateButtonText",
        accessKey: "notifyBarUpdateButtonAccessKey",
        popup:     null,
        callback:  function(aButton) {
          self._updateLogin(aOldLogin, aNewLogin);
        }
      },

      // "No" button
      {
        label:     "notifyBarDontChangeButtonText",
        accessKey: "notifyBarDontChangeButtonAccessKey",
        popup:     null,
        callback:  function(aButton) {
          // do nothing
        }
      }
    ];

    this._showLoginNotification(aBrowser, "password-change", notificationTextBundle,
                                buttons, formData);

    let oldGUID = aOldLogin.QueryInterface(Ci.nsILoginMetaInfo).guid;
    Services.obs.notifyObservers(aNewLogin, "passwordmgr-prompt-change", oldGUID);
  },

  /**
   * Shows the Change Password notification bar or popup notification which
   * allows the user to select a username to update.
   *
   * @param aBrowser
   *        The browser of the webpage request that triggered the prompt.
   * @param logins
   *        The list of possible usernames for the user to select.
   * @param aNewLogin
   *        The login object with the changes we want to make.
   */
  _showChangeLoginWithUsernamesNotification(aBrowser, logins, aNewLogin) {
    // We reuse the existing message, even if it expects a username, until we
    // switch to the final terminology in bug 1144856.
    var displayHost = this._getShortDisplayHost(aNewLogin.hostname);
    var notificationTextBundle = ["passwordChangeTitle"];
    var usernames = logins.map(l => this._sanitizeUsername(l.username));
    var dialogTextBundle  = ["userSelectText2"];

    var formData = {
      "textBundle": dialogTextBundle
    };

    // The callbacks in |buttons| have a closure to access the variables
    // in scope here; set one to |this._pwmgr| so we can get back to pwmgr
    // without a getService() call.
    var self = this;

    var buttons = [
      // "Yes" button
      {
        label:     "notifyBarUpdateButtonText",
        accessKey: "notifyBarUpdateButtonAccessKey",
        popup:     null,
        callback:  function(aButton, selectedIndex) {
          // Now that we know which login to use, modify its password.
          var selectedLogin = logins[selectedIndex];
          var newLoginWithUsername = Cc["@mozilla.org/login-manager/loginInfo;1"].
                         createInstance(Ci.nsILoginInfo);
          newLoginWithUsername.init(aNewLogin.hostname,
                                    aNewLogin.formSubmitURL, aNewLogin.httpRealm,
                                    selectedLogin.username, aNewLogin.password,
                                    selectedLogin.userNameField, aNewLogin.passwordField);
          self._updateLogin(selectedLogin, newLoginWithUsername);
        }
      },

      // "No" button
      {
        label:     "notifyBarDontChangeButtonText",
        accessKey: "notifyBarDontChangeButtonAccessKey",
        popup:     null,
        callback:  function(aButton) {
          // do nothing
        }
      }
    ];

    this._showLoginNotification(aBrowser, "password-update-multiuser", notificationTextBundle,
                                buttons, formData);
  },

  _updateLogin(login, aNewLogin = null) {
    var now = Date.now();
    var propBag = Cc["@mozilla.org/hash-property-bag;1"].
                  createInstance(Ci.nsIWritablePropertyBag);
    if (aNewLogin) {
      propBag.setProperty("formSubmitURL", aNewLogin.formSubmitURL);
      propBag.setProperty("hostname", aNewLogin.hostname);
      propBag.setProperty("password", aNewLogin.password);
      propBag.setProperty("username", aNewLogin.username);
      // Explicitly set the password change time here (even though it would
      // be changed automatically), to ensure that it's exactly the same
      // value as timeLastUsed.
      propBag.setProperty("timePasswordChanged", now);
    }
    propBag.setProperty("timeLastUsed", now);
    propBag.setProperty("timesUsedIncrement", 1);
    this._pwmgr.modifyLogin(login, propBag);
  },

  /**
   * Given a content DOM window, returns the chrome window and browser it's in.
   */
  _getChromeWindow: function (aWindow) {
    let windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      let win = windows.getNext();
      let browser = win.gBrowser.getBrowserForContentWindow(aWindow);
      if (browser) {
        return { win, browser };
      }
    }
    return null;
  },

  _getNotifyWindow: function () {
    // Some sites pop up a temporary login window, which disappears
    // upon submission of credentials. We want to put the notification
    // bar in the opener window if this seems to be happening.
    if (this._opener) {
      let chromeDoc = this._chromeWindow.document.documentElement;

      // Check to see if the current window was opened with chrome
      // disabled, and if so use the opener window. But if the window
      // has been used to visit other pages (ie, has a history),
      // assume it'll stick around and *don't* use the opener.
      if (chromeDoc.getAttribute("chromehidden") && !this._browser.canGoBack) {
        this.log("Using opener window for notification bar.");
        return this._getChromeWindow(this._opener);
      }
    }

    return { win: this._chromeWindow, browser: this._browser };
  },

  /**
   * Returns the popup notification to this prompter,
   * or null if there isn't one available.
   */
  _getPopupNote : function () {
    let popupNote = null;

    try {
      let { win: notifyWin } = this._getNotifyWindow();

      // .wrappedJSObject needed here -- see bug 422974 comment 5.
      popupNote = notifyWin.wrappedJSObject.PopupNotifications;
    } catch (e) {
      this.log("Popup notifications not available on window");
    }

    return popupNote;
  },

  /**
   * Returns the notification box to this prompter, or null if there isn't
   * a notification box available.
   */
  _getNotifyBox : function () {
    let notifyBox = null;

    try {
      let { win: notifyWin } = this._getNotifyWindow();

      // .wrappedJSObject needed here -- see bug 422974 comment 5.
      notifyBox = notifyWin.wrappedJSObject.getNotificationBox(notifyWin);
    } catch (e) {
      this.log("Notification bars not available on window");
    }

    return notifyBox;
  },

  /**
   * The user might enter a login that isn't the one we prefilled, but
   * is the same as some other existing login. So, pick a login with a
   * matching username, or return null.
   */
  _repickSelectedLogin : function (foundLogins, username) {
    for (var i = 0; i < foundLogins.length; i++)
      if (foundLogins[i].username == username)
        return foundLogins[i];
    return null;
  },

  /**
   * Sanitizes the specified username, by stripping quotes and truncating if
   * it's too long. This helps prevent an evil site from messing with the
   * "save password?" prompt too much.
   */
  _sanitizeUsername : function (username) {
    if (username.length > 30) {
      username = username.substring(0, 30);
      username += this._ellipsis;
    }
    return username.replace(/['"]/g, "");
  },


  /**
   * The aURI parameter may either be a string uri, or an nsIURI instance.
   *
   * Returns the hostname to use in a nsILoginInfo object (for example,
   * "http://example.com").
   */
  _getFormattedHostname : function (aURI) {
    let uri;
    if (aURI instanceof Ci.nsIURI) {
      uri = aURI;
    } else {
      uri = Services.io.newURI(aURI, null, null);
    }

    return uri.scheme + "://" + uri.hostPort;
  },


  /**
   * Converts a login's hostname field (a URL) to a short string for
   * prompting purposes. Eg, "http://foo.com" --> "foo.com", or
   * "ftp://www.site.co.uk" --> "site.co.uk".
   */
  _getShortDisplayHost: function (aURIString) {
    var displayHost;

    var eTLDService = Cc["@mozilla.org/network/effective-tld-service;1"].
                      getService(Ci.nsIEffectiveTLDService);
    var idnService = Cc["@mozilla.org/network/idn-service;1"].
                     getService(Ci.nsIIDNService);
    try {
      var uri = Services.io.newURI(aURIString, null, null);
      var baseDomain = eTLDService.getBaseDomain(uri);
      displayHost = idnService.convertToDisplayIDN(baseDomain, {});
    } catch (e) {
      this.log("_getShortDisplayHost couldn't process " + aURIString);
    }

    if (!displayHost)
      displayHost = aURIString;

    return displayHost;
  },


  /**
   * Returns the hostname and realm for which authentication is being
   * requested, in the format expected to be used with nsILoginInfo.
   */
  _getAuthTarget : function (aChannel, aAuthInfo) {
    var hostname, realm;

    // If our proxy is demanding authentication, don't use the
    // channel's actual destination.
    if (aAuthInfo.flags & Ci.nsIAuthInformation.AUTH_PROXY) {
      this.log("getAuthTarget is for proxy auth");
      if (!(aChannel instanceof Ci.nsIProxiedChannel))
        throw new Error("proxy auth needs nsIProxiedChannel");

      var info = aChannel.proxyInfo;
      if (!info)
        throw new Error("proxy auth needs nsIProxyInfo");

      // Proxies don't have a scheme, but we'll use "moz-proxy://"
      // so that it's more obvious what the login is for.
      var idnService = Cc["@mozilla.org/network/idn-service;1"].
                       getService(Ci.nsIIDNService);
      hostname = "moz-proxy://" +
                  idnService.convertUTF8toACE(info.host) +
                  ":" + info.port;
      realm = aAuthInfo.realm;
      if (!realm)
        realm = hostname;

      return [hostname, realm];
    }

    hostname = this._getFormattedHostname(aChannel.URI);

    // If a HTTP WWW-Authenticate header specified a realm, that value
    // will be available here. If it wasn't set or wasn't HTTP, we'll use
    // the formatted hostname instead.
    realm = aAuthInfo.realm;
    if (!realm)
      realm = hostname;

    return [hostname, realm];
  },


  /**
   * Returns [username, password] as extracted from aAuthInfo (which
   * holds this info after having prompted the user).
   *
   * If the authentication was for a Windows domain, we'll prepend the
   * return username with the domain. (eg, "domain\user")
   */
  _GetAuthInfo : function (aAuthInfo) {
    var username, password;

    var flags = aAuthInfo.flags;
    if (flags & Ci.nsIAuthInformation.NEED_DOMAIN && aAuthInfo.domain)
      username = aAuthInfo.domain + "\\" + aAuthInfo.username;
    else
      username = aAuthInfo.username;

    password = aAuthInfo.password;

    return [username, password];
  },


  /**
   * Given a username (possibly in DOMAIN\user form) and password, parses the
   * domain out of the username if necessary and sets domain, username and
   * password on the auth information object.
   */
  _SetAuthInfo : function (aAuthInfo, username, password) {
    var flags = aAuthInfo.flags;
    if (flags & Ci.nsIAuthInformation.NEED_DOMAIN) {
      // Domain is separated from username by a backslash
      var idx = username.indexOf("\\");
      if (idx == -1) {
        aAuthInfo.username = username;
      } else {
        aAuthInfo.domain   =  username.substring(0, idx);
        aAuthInfo.username =  username.substring(idx + 1);
      }
    } else {
      aAuthInfo.username = username;
    }
    aAuthInfo.password = password;
  },

  _newAsyncPromptConsumer : function(aCallback, aContext) {
    return {
      QueryInterface: ChromeUtils.generateQI([Ci.nsICancelable]),
      callback: aCallback,
      context: aContext,
      cancel: function() {
        this.callback.onAuthCancelled(this.context, false);
        this.callback = null;
        this.context = null;
      }
    };
  },

  /**
   * This function looks for existing logins that can be updated
   * to match a submitted login, instead of creating a new one.
   *
   * Given a login and a loginList, it filters the login list
   * to find every login with either the same username as aLogin
   * or with the same password as aLogin and an empty username
   * so the user can add a username.
   *
   * @param {nsILoginInfo} aLogin
   *                       login to use as filter.
   * @param {nsILoginInfo[]} aLoginList
   *                         Array of logins to filter.
   * @returns {nsILoginInfo[]} the filtered array of logins.
   */
  _filterUpdatableLogins(aLogin, aLoginList) {
    return aLoginList.filter(l => l.username == aLogin.username ||
                             (l.password == aLogin.password &&
                              !l.username));
  },

}; // end of LoginManagerPrompter implementation

XPCOMUtils.defineLazyGetter(this.LoginManagerPrompter.prototype, "log", () => {
  let logger = Logger
  return logger.debug.bind(logger);
});

XPCOMUtils.defineLazyGetter(this.LoginManagerPrompter.prototype, "warn", () => {
  let logger = Logger
  return logger.warn.bind(logger);
});

var component = [LoginManagerPromptFactory, LoginManagerPrompter];
this.NSGetFactory = XPCOMUtils.generateNSGetFactory(component);
