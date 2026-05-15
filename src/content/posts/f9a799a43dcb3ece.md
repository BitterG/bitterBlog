---
title: "双向验证逆向笔记"
date: "2026-05-15"
updated: "2026-05-15T01:38:48.568Z"
category: "frida"
tags: ["Frida", "Android", "逆向"]
---

# 双向验证逆向笔记

题目：猿人学 借问酒家何处有

手机开启代理，pc启动charless进行中间人抓包，发现页面数据无法加载

![图片](/img/frida/f9a799a43dcb3ece/1754818691310-511f5c24-0c05-4dab-bfe0-cd44ca210ee6-546523.png)

1.解决方法 使用frida脚本过客户端校验服务端证书  

脚本来源[https://github.com/apkunpacker/FridaScripts/blob/main/SSLUnpinning.js](https://github.com/apkunpacker/FridaScripts/blob/main/SSLUnpinning.js)

```cpp
console.warn(Process.arch, "environment Detected")
/*
On higher version of android , there may be issue that android reject runtime registered classes
and throw error that writable dex are not allowed. We can try to set different permission for those file.
*/
Java.performNow(function () {
    const DexClassLoader = Java.use("dalvik.system.DexClassLoader");
    DexClassLoader.$init.implementation = function (dexPath, optimizedDirectory, libraryPath, parent) {
        const JFile = Java.use('java.io.File');
        if (dexPath.includes("/data/data/") && dexPath.includes("frida") && dexPath.includes("dex")) {
            console.warn(`[*] Making ${dexPath} readonly`)
            JFile.$new(dexPath).setReadOnly()
            this.$init(dexPath, optimizedDirectory, libraryPath, parent);
        }
        this.$init(dexPath, optimizedDirectory, libraryPath, parent);
    };
})

let do_dlopen = null;
let call_ctor = null;
let LibraryName = "libflutter.so";
let moduleName = Process.arch == "arm" ? "linker" : "linker64";
let reg = Process.arch == "arm" ? "r0" : "x0";
let Arch = Process.arch;
Process.findModuleByName(moduleName)
    .enumerateSymbols()
    .forEach(function (sym) {
        if (sym.name.indexOf('do_dlopen') !== -1) {
            do_dlopen = sym.address;
        } else if (sym.name.indexOf('call_constructor') !== -1) {
            call_ctor = sym.address;
        }
    })
Interceptor.attach(do_dlopen, function () {
    let Lib = this.context[reg].readCString();
    if (Lib && Lib.indexOf(LibraryName) !== -1) {
        Interceptor.attach(call_ctor, function () {
            Hook(LibraryName);
        })
    }
})

function Hook(Name) {

    let Hooked = 0;
    let Mod = Process.findModuleByName(Name);
    let Arm64Pattern = [
        "F? 0F 1C F8 F? 5? 01 A9 F? 5? 02 A9 F? ?? 03 A9 ?? ?? ?? ?? 68 1A 40 F9",
        "F? 43 01 D1 FE 67 01 A9 F8 5F 02 A9 F6 57 03 A9 F4 4F 04 A9 13 00 40 F9 F4 03 00 AA 68 1A 40 F9",
        "FF 43 01 D1 FE 67 01 A9 ?? ?? 06 94 ?? 7? 06 94 68 1A 40 F9 15 15 41 F9 B5 00 00 B4 B6 4A 40 F9",
        "FF C3 01 D1 FD 7B 01 A9 FC 6F 02 A9 FA 67 03 A9 F8 5F 04 A9 F6 57 05 A9 F4 4F 06 A9 08 0A 80 52 48 00 00 39"];
    let ArmPattern = ["2D E9 F? 4? D0 F8 00 80 81 46 D8 F8 18 00 D0 F8 ??"];
    if (Arch == "arm64") {
        Arm64Pattern.forEach(pattern => {
            Memory.scan(Mod.base, Mod.size, pattern, {
                onMatch: function (address, size) {
                    //if (Hooked == 0) 
                    {
                        Hooked = 1;
                        hook_ssl_verify_peer_cert(address, address.sub(Mod.base), Name);
                    }
                }
            });
        });
    } else if (Arch == "arm") {
        ArmPattern.forEach(pattern => {
            Memory.scan(Mod.base, Mod.size, pattern, {
                onMatch: function (address, size) {
                    if (Hooked == 0) {
                        Hooked = 1;
                        hook_ssl_verify_peer_cert(address, address.sub(Mod.base), Name);
                    }
                }
            });
        });
    }
}

function hook_ssl_verify_peer_cert(address) {
    console.log("ssl_verify_peer_cert Patched at : ", address)
    try {
        Interceptor.replace(address, new NativeCallback((pathPtr, flags) => {
            return 1;
        }, 'int', ['pointer', 'int']));
    } catch (e) { }
}

function CommonMethods() {

    try {
        const HttpsURLConnection = Java.use("javax.net.ssl.HttpsURLConnection");
        HttpsURLConnection.setDefaultHostnameVerifier.implementation = function (hostnameVerifier) {
            console.log('[+] Bypassing HttpsURLConnection (setDefaultHostnameVerifier)');
        };
        console.log('[+] HttpsURLConnection (setDefaultHostnameVerifier)');
    } catch (err) { }
    try {
        const HttpsURLConnection = Java.use("javax.net.ssl.HttpsURLConnection");
        HttpsURLConnection.setSSLSocketFactory.implementation = function (SSLSocketFactory) {
            console.log('[+] Bypassing HttpsURLConnection (setSSLSocketFactory)');
        };
        console.log('[+] HttpsURLConnection (setSSLSocketFactory)');
    } catch (err) { }
    try {
        const HttpsURLConnection = Java.use("javax.net.ssl.HttpsURLConnection");
        HttpsURLConnection.setHostnameVerifier.implementation = function (hostnameVerifier) {
            console.log('[+] Bypassing HttpsURLConnection (setHostnameVerifier)');
        };
        console.log('[+] HttpsURLConnection (setHostnameVerifier)');
    } catch (err) { }
    try {

        const X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
        const SSLContext = Java.use('javax.net.ssl.SSLContext');

        const TrustManager = Java.registerClass({
            name: 'incogbyte.bypass.test.TrustManager',
            implements: [X509TrustManager],
            methods: {
                checkClientTrusted: function (chain, authType) { },
                checkServerTrusted: function (chain, authType) { },
                getAcceptedIssuers: function () {
                    return [];
                }
            }
        });

        const TrustManagers = [TrustManager.$new()];

        const SSLContext_init = SSLContext.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
        SSLContext_init.implementation = function (keyManager, trustManager, secureRandom) {
            console.log('[+] Bypassing Trustmanager (Android < 7) Request');
            SSLContext_init.call(this, keyManager, TrustManagers, secureRandom);
        };

        console.log('[+] SSLContext');
    } catch (err) { }
    try {
        const array_list = Java.use("java.util.ArrayList");
        const TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        TrustManagerImpl.checkTrustedRecursive.implementation = function (a1, a2, a3, a4, a5, a6) {
            console.log('[+] Bypassing TrustManagerImpl checkTrusted');            
            return array_list.$new();
        }
        TrustManagerImpl.verifyChain.implementation = function (untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
            console.log('[+] Bypassing TrustManagerImpl verifyChain: ' + host);
            return untrustedChain;
        };
        console.log('[+] TrustManagerImpl');
    } catch (err) { }
    try {
        const okhttp3_Activity_1 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_1.check.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 (list): ' + a);
            };
        console.log('[+] OkHTTPv3 (list)');
    } catch (err) { }
    try {
        const okhttp3_Activity_2 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_2.check.overload('java.lang.String', 'java.security.cert.Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 (cert): ' + a);
            };
        console.log('[+] OkHTTPv3 (cert)');
    } catch (err) { }
    try {
        const okhttp3_Activity_3 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_3.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 (cert array): ' + a);
            };
        console.log('[+] OkHTTPv3 (cert array)');
    } catch (err) { }
    try {
        const okhttp3_Activity_4 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_4['check$okhttp'].implementation = function (a, b) {
            console.log('[+] Bypassing OkHTTPv3 ($okhttp): ' + a);
        };
        console.log('[+] OkHTTPv3 ($okhttp)');
    } catch (err) { }
    try {
        const trustkit_Activity_1 = Java.use('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier');
        trustkit_Activity_1.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Trustkit OkHostnameVerifier(SSLSession): ' + a);
                return true;
            };
        console.log('[+] Trustkit OkHostnameVerifier(SSLSession)');
    } catch (err) { }
    try {
        const trustkit_Activity_2 = Java.use('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier');
        trustkit_Activity_2.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Trustkit OkHostnameVerifier(cert): ' + a);
                return true;
            };
        console.log('[+] Trustkit OkHostnameVerifier(cert)');
    } catch (err) { }
    try {
        const trustkit_PinningTrustManager = Java.use('com.datatheorem.android.trustkit.pinning.PinningTrustManager');
        trustkit_PinningTrustManager.checkServerTrusted.implementation = function () {
            console.log('[+] Bypassing Trustkit PinningTrustManager');
        };
        console.log('[+] Trustkit PinningTrustManager');
    } catch (err) { }
    try {
        const appcelerator_PinningTrustManager = Java.use('appcelerator.https.PinningTrustManager');
        appcelerator_PinningTrustManager.checkServerTrusted.implementation = function () {
            console.log('[+] Bypassing Appcelerator PinningTrustManager');
        };
        console.log('[+] Appcelerator PinningTrustManager');
    } catch (err) { }
    try {
        const OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
        OpenSSLSocketImpl.verifyCertificateChain.implementation = function (certRefs, JavaObject, authMethod) {
            console.log('[+] Bypassing OpenSSLSocketImpl Conscrypt');
        };
        console.log('[+] OpenSSLSocketImpl Conscrypt');
    } catch (err) { }
    try {
        const OpenSSLEngineSocketImpl_Activity = Java.use('com.android.org.conscrypt.OpenSSLEngineSocketImpl');
        OpenSSLEngineSocketImpl_Activity.verifyCertificateChain.overload('[Ljava.lang.Long;', 'java.lang.String')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OpenSSLEngineSocketImpl Conscrypt: ' + b);
            };
        console.log('[+] OpenSSLEngineSocketImpl Conscrypt');
    } catch (err) { }
    try {
        const OpenSSLSocketImpl_Harmony = Java.use('org.apache.harmony.xnet.provider.jsse.OpenSSLSocketImpl');
        OpenSSLSocketImpl_Harmony.verifyCertificateChain.implementation = function (asn1DerEncodedCertificateChain, authMethod) {
            console.log('[+] Bypassing OpenSSLSocketImpl Apache Harmony');
        };
        console.log('[+] OpenSSLSocketImpl Apache Harmony');
    } catch (err) { }
    try {
        const phonegap_Activity = Java.use('nl.xservices.plugins.sslCertificateChecker');
        phonegap_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
            .implementation = function (a, b, c) {
                console.log('[+] Bypassing PhoneGap sslCertificateChecker: ' + a);
                return true;
            };
        console.log('[+] PhoneGap sslCertificateChecker');
    } catch (err) { }
    try {
        const WLClient_Activity_1 = Java.use('com.worklight.wlclient.api.WLClient');
        WLClient_Activity_1.getInstance()
            .pinTrustedCertificatePublicKey.overload('java.lang.String')
            .implementation = function (cert) {
                console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey (string): ' + cert);
                return;
            };
        console.log('[+] IBM MobileFirst pinTrustedCertificatePublicKey (string)');
    } catch (err) { }
    try {
        const WLClient_Activity_2 = Java.use('com.worklight.wlclient.api.WLClient');
        WLClient_Activity_2.getInstance()
            .pinTrustedCertificatePublicKey.overload('[Ljava.lang.String;')
            .implementation = function (cert) {
                console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey (string array): ' + cert);
                return;
            };
        console.log('[+] IBM MobileFirst pinTrustedCertificatePublicKey (string array)');
    } catch (err) { }
    try {
        const worklight_Activity_1 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_1.verify.overload('java.lang.String', 'javax.net.ssl.SSLSocket')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning (SSLSocket): ' + a);
                return;
            };
        console.log('[+] IBM WorkLight HostNameVerifierWithCertificatePinning (SSLSocket)');
    } catch (err) { }
    try {
        const worklight_Activity_2 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_2.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning (cert): ' + a);
                return;
            };
        console.log('[+] IBM WorkLight HostNameVerifierWithCertificatePinning (cert)');
    } catch (err) { }
    try {
        const worklight_Activity_3 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_3.verify.overload('java.lang.String', '[Ljava.lang.String;', '[Ljava.lang.String;')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning (string string): ' + a);
                return;
            };
        console.log('[+] IBM WorkLight HostNameVerifierWithCertificatePinning (string string)');
    } catch (err) { }
    try {
        const worklight_Activity_4 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_4.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning (SSLSession): ' + a);
                return true;
            };
        console.log('[+] IBM WorkLight HostNameVerifierWithCertificatePinning (SSLSession)');
    } catch (err) { }
    try {
        const conscrypt_CertPinManager_Activity = Java.use('com.android.org.conscrypt.CertPinManager');
        conscrypt_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Conscrypt CertPinManager: ' + a);
                return true;
            };
        console.log('[+] Conscrypt CertPinManager');
    } catch (err) { }
    try {
        const cwac_CertPinManager_Activity = Java.use('com.commonsware.cwac.netsecurity.conscrypt.CertPinManager');
        cwac_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing CWAC-Netsecurity CertPinManager: ' + a);
                return true;
            };
        console.log('[+] CWAC-Netsecurity CertPinManager');
    } catch (err) { }
    try {
        const androidgap_WLCertificatePinningPlugin_Activity = Java.use('com.worklight.androidgap.plugin.WLCertificatePinningPlugin');
        androidgap_WLCertificatePinningPlugin_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
            .implementation = function (a, b, c) {
                console.log('[+] Bypassing Worklight Androidgap WLCertificatePinningPlugin: ' + a);
                return true;
            };
        console.log('[+] Worklight Androidgap WLCertificatePinningPlugin');
    } catch (err) { }
    try {
        const netty_FingerprintTrustManagerFactory = Java.use('io.netty.handler.ssl.util.FingerprintTrustManagerFactory');
        netty_FingerprintTrustManagerFactory.checkTrusted.implementation = function (type, chain) {
            console.log('[+] Bypassing Netty FingerprintTrustManagerFactory');
        };
        console.log('[+] Netty FingerprintTrustManagerFactory');
    } catch (err) { }
    try {
        const Squareup_CertificatePinner_Activity_1 = Java.use('com.squareup.okhttp.CertificatePinner');
        Squareup_CertificatePinner_Activity_1.check.overload('java.lang.String', 'java.security.cert.Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup CertificatePinner (cert): ' + a);
                return;
            };
        console.log('[+] Squareup CertificatePinner (cert)');
    } catch (err) { }
    try {
        const Squareup_CertificatePinner_Activity_2 = Java.use('com.squareup.okhttp.CertificatePinner');
        Squareup_CertificatePinner_Activity_2.check.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup CertificatePinner (list): ' + a);
                return null;
            };
        console.log('[+] Squareup CertificatePinner (list)');
    } catch (err) { }
    try {
        const Squareup_OkHostnameVerifier_Activity_1 = Java.use('com.squareup.okhttp.internal.tls.OkHostnameVerifier');
        Squareup_OkHostnameVerifier_Activity_1.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup OkHostnameVerifier (cert): ' + a);
                return true;
            };
        console.log('[+] Squareup OkHostnameVerifier (cert)');
    } catch (err) { }
    try {
        const Squareup_OkHostnameVerifier_Activity_2 = Java.use('com.squareup.okhttp.internal.tls.OkHostnameVerifier');
        Squareup_OkHostnameVerifier_Activity_2.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup OkHostnameVerifier (SSLSession): ' + a);
                return true;
            };
        console.log('[+] Squareup OkHostnameVerifier (SSLSession)');
    } catch (err) { }
    try {
        const AndroidWebViewClient_Activity_1 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_1.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Android WebViewClient (SslErrorHandler)');
            };
        console.log('[+] Android WebViewClient (SslErrorHandler)');
    } catch (err) { }
    try {
        const AndroidWebViewClient_Activity_2 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_2.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Android WebViewClient (WebResourceError)');
            };
        console.log('[+] Android WebViewClient (WebResourceError)');
    } catch (err) { }
    try {
        const CordovaWebViewClient_Activity = Java.use('org.apache.cordova.CordovaWebViewClient');
        CordovaWebViewClient_Activity.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Apache Cordova WebViewClient');
                obj3.proceed();
            };
        console.log('[+] Apache Cordova WebViewClient');
    } catch (err) { }
    try {
        const boye_AbstractVerifier = Java.use('ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier');
        boye_AbstractVerifier.verify.implementation = function (host, ssl) {
            console.log('[+] Bypassing Boye AbstractVerifier: ' + host);
        };
        console.log('[+] Boye AbstractVerifier');
    } catch (err) { }
}

function dynamicPatching() {
    /*
     var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
     var SSLContext = Java.use('javax.net.ssl.SSLContext');
     var TrustManager = Java.registerClass({
         name: 'incogbyte.bypass.test.TrustManager',
         implements: [X509TrustManager],
         methods: {
             checkClientTrusted: function(chain, authType) {},
             checkServerTrusted: function(chain, authType) {},
             getAcceptedIssuers: function() {
                 return [];
             }
         }
     });
     */
    try {
        var okhttp3_Activity_1 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_1.check.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 {1}: ' + a);
            };
    } catch (err) { }
    try {
        var okhttp3_Activity_2 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_2.check.overload('java.lang.String', 'java.security.cert.Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 {2}: ' + a);
            };
    } catch (err) { }
    try {
        var okhttp3_Activity_3 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_3.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 {3}: ' + a);
            };
    } catch (err) { }
    try {
        var okhttp3_Activity_4 = Java.use('okhttp3.CertificatePinner');
        okhttp3_Activity_4.check$okhttp.overload('java.lang.String', 'kotlin.jvm.functions.Function0')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OkHTTPv3 {4}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var trustkit_Activity_1 = Java.use('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier');
        trustkit_Activity_1.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Trustkit {1}: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var trustkit_Activity_2 = Java.use('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier');
        trustkit_Activity_2.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Trustkit {2}: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var trustkit_PinningTrustManager = Java.use('com.datatheorem.android.trustkit.pinning.PinningTrustManager');
        trustkit_PinningTrustManager.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String')
            .implementation = function (chain, authType) {
                console.log('[+] Bypassing Trustkit {3}');
            };
    } catch (err) { }
    try {
        var array_list = Java.use("java.util.ArrayList");
        var TrustManagerImpl_Activity_1 = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        TrustManagerImpl_Activity_1.checkTrustedRecursive.implementation = function (certs, ocspData, tlsSctData, host, clientAuth, untrustedChain, trustAnchorChain, used) {
            console.log('[+] Bypassing TrustManagerImpl (Android > 7) checkTrustedRecursive check: ' + host);
            return array_list.$new();
        };
    } catch (err) { }
    try {
        var TrustManagerImpl_Activity_2 = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        TrustManagerImpl_Activity_2.verifyChain.implementation = function (untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
            console.log('[+] Bypassing TrustManagerImpl (Android > 7) verifyChain check: ' + host);
            return untrustedChain;
        };
    } catch (err) { }
    try {
        var appcelerator_PinningTrustManager = Java.use('appcelerator.https.PinningTrustManager');
        appcelerator_PinningTrustManager.checkServerTrusted.implementation = function (chain, authType) {
            console.log('[+] Bypassing Appcelerator PinningTrustManager');
            return;
        };
    } catch (err) { }
    try {
        var fabric_PinningTrustManager = Java.use('io.fabric.sdk.android.services.network.PinningTrustManager');
        fabric_PinningTrustManager.checkServerTrusted.implementation = function (chain, authType) {
            console.log('[+] Bypassing Fabric PinningTrustManager');
            return;
        };
    } catch (err) { }
    try {
        var OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
        OpenSSLSocketImpl.verifyCertificateChain.implementation = function (certRefs, JavaObject, authMethod) {
            console.log('[+] Bypassing OpenSSLSocketImpl Conscrypt {1}');
        };
    } catch (err) { }
    try {
        var OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
        OpenSSLSocketImpl.verifyCertificateChain.implementation = function (certChain, authMethod) {
            console.log('[+] Bypassing OpenSSLSocketImpl Conscrypt {2}');
        };
    } catch (err) { }
    try {
        var OpenSSLEngineSocketImpl_Activity = Java.use('com.android.org.conscrypt.OpenSSLEngineSocketImpl');
        OpenSSLEngineSocketImpl_Activity.verifyCertificateChain.overload('[Ljava.lang.Long;', 'java.lang.String')
            .implementation = function (a, b) {
                console.log('[+] Bypassing OpenSSLEngineSocketImpl Conscrypt: ' + b);
            };
    } catch (err) { }
    try {
        var OpenSSLSocketImpl_Harmony = Java.use('org.apache.harmony.xnet.provider.jsse.OpenSSLSocketImpl');
        OpenSSLSocketImpl_Harmony.verifyCertificateChain.implementation = function (asn1DerEncodedCertificateChain, authMethod) {
            console.log('[+] Bypassing OpenSSLSocketImpl Apache Harmony');
        };
    } catch (err) { }
    try {
        var phonegap_Activity = Java.use('nl.xservices.plugins.sslCertificateChecker');
        phonegap_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
            .implementation = function (a, b, c) {
                console.log('[+] Bypassing PhoneGap sslCertificateChecker: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var WLClient_Activity_1 = Java.use('com.worklight.wlclient.api.WLClient');
        WLClient_Activity_1.getInstance()
            .pinTrustedCertificatePublicKey.overload('java.lang.String')
            .implementation = function (cert) {
                console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey {1}: ' + cert);
                return;
            };
    } catch (err) { }
    try {
        var WLClient_Activity_2 = Java.use('com.worklight.wlclient.api.WLClient');
        WLClient_Activity_2.getInstance()
            .pinTrustedCertificatePublicKey.overload('[Ljava.lang.String;')
            .implementation = function (cert) {
                console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey {2}: ' + cert);
                return;
            };
    } catch (err) { }
    try {
        var worklight_Activity_1 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_1.verify.overload('java.lang.String', 'javax.net.ssl.SSLSocket')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {1}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var worklight_Activity_2 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_2.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {2}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var worklight_Activity_3 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_3.verify.overload('java.lang.String', '[Ljava.lang.String;', '[Ljava.lang.String;')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {3}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var worklight_Activity_4 = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
        worklight_Activity_4.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {4}: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var conscrypt_CertPinManager_Activity = Java.use('com.android.org.conscrypt.CertPinManager');
        conscrypt_CertPinManager_Activity.checkChainPinning.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Conscrypt CertPinManager: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var legacy_conscrypt_CertPinManager_Activity = Java.use('com.android.org.conscrypt.CertPinManager');
        legacy_conscrypt_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Conscrypt CertPinManager (Legacy): ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var cwac_CertPinManager_Activity = Java.use('com.commonsware.cwac.netsecurity.conscrypt.CertPinManager');
        cwac_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing CWAC-Netsecurity CertPinManager: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var androidgap_WLCertificatePinningPlugin_Activity = Java.use('com.worklight.androidgap.plugin.WLCertificatePinningPlugin');
        androidgap_WLCertificatePinningPlugin_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
            .implementation = function (a, b, c) {
                console.log('[+] Bypassing Worklight Androidgap WLCertificatePinningPlugin: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var netty_FingerprintTrustManagerFactory = Java.use('io.netty.handler.ssl.util.FingerprintTrustManagerFactory');
        //var netty_FingerprintTrustManagerFactory = Java.use('org.jboss.netty.handler.ssl.util.FingerprintTrustManagerFactory');
        netty_FingerprintTrustManagerFactory.checkTrusted.implementation = function (type, chain) {
            console.log('[+] Bypassing Netty FingerprintTrustManagerFactory');
        };
    } catch (err) { }
    try {
        var Squareup_CertificatePinner_Activity_1 = Java.use('com.squareup.okhttp.CertificatePinner');
        Squareup_CertificatePinner_Activity_1.check.overload('java.lang.String', 'java.security.cert.Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup CertificatePinner {1}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var Squareup_CertificatePinner_Activity_2 = Java.use('com.squareup.okhttp.CertificatePinner');
        Squareup_CertificatePinner_Activity_2.check.overload('java.lang.String', 'java.util.List')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup CertificatePinner {2}: ' + a);
                return;
            };
    } catch (err) { }
    try {
        var Squareup_OkHostnameVerifier_Activity_1 = Java.use('com.squareup.okhttp.internal.tls.OkHostnameVerifier');
        Squareup_OkHostnameVerifier_Activity_1.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup OkHostnameVerifier {1}: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var Squareup_OkHostnameVerifier_Activity_2 = Java.use('com.squareup.okhttp.internal.tls.OkHostnameVerifier');
        Squareup_OkHostnameVerifier_Activity_2.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
            .implementation = function (a, b) {
                console.log('[+] Bypassing Squareup OkHostnameVerifier {2}: ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var AndroidWebViewClient_Activity_1 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_1.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Android WebViewClient check {1}');
            };
    } catch (err) { }
    try {
        var AndroidWebViewClient_Activity_2 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_2.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Android WebViewClient check {2}');
            };
    } catch (err) { }
    try {
        var AndroidWebViewClient_Activity_3 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_3.onReceivedError.overload('android.webkit.WebView', 'int', 'java.lang.String', 'java.lang.String')
            .implementation = function (obj1, obj2, obj3, obj4) {
                console.log('[+] Bypassing Android WebViewClient check {3}');
            };
    } catch (err) { }
    try {
        var AndroidWebViewClient_Activity_4 = Java.use('android.webkit.WebViewClient');
        AndroidWebViewClient_Activity_4.onReceivedError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Android WebViewClient check {4}');
                            Java.perform(function() {
    let AndroidLog = Java.use("android.util.Log");
    let ExceptionClass = Java.use("java.lang.Exception");
    console.warn(AndroidLog.getStackTraceString(ExceptionClass.$new()));
});
            };
    } catch (err) { }
    try {
        var CordovaWebViewClient_Activity = Java.use('org.apache.cordova.CordovaWebViewClient');
        CordovaWebViewClient_Activity.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
            .implementation = function (obj1, obj2, obj3) {
                console.log('[+] Bypassing Apache Cordova WebViewClient check');
                obj3.proceed();
            };
    } catch (err) { }
    try {
        var boye_AbstractVerifier = Java.use('ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier');
        boye_AbstractVerifier.verify.implementation = function (host, ssl) {
            console.log('[+] Bypassing Boye AbstractVerifier check: ' + host);
        };
    } catch (err) { }
    try {
        var apache_AbstractVerifier = Java.use('org.apache.http.conn.ssl.AbstractVerifier');
        apache_AbstractVerifier.verify.implementation = function (a, b, c, d) {
            console.log('[+] Bypassing Apache AbstractVerifier check: ' + a);
            return;
        };
    } catch (err) { }
    try {
        var CronetEngineBuilderImpl_Activity = Java.use("org.chromium.net.impl.CronetEngineBuilderImpl");
        CronetEngine_Activity.enablePublicKeyPinningBypassForLocalTrustAnchors.overload('boolean')
            .implementation = function (a) {
                console.log("[+] Disabling Public Key pinning for local trust anchors in Chromium Cronet");
                var cronet_obj_1 = CronetEngine_Activity.enablePublicKeyPinningBypassForLocalTrustAnchors.call(this, true);
                return cronet_obj_1;
            };
        CronetEngine_Activity.addPublicKeyPins.overload('java.lang.String', 'java.util.Set', 'boolean', 'java.util.Date')
            .implementation = function (hostName, pinsSha256, includeSubdomains, expirationDate) {
                console.log("[+] Bypassing Chromium Cronet pinner: " + hostName);
                var cronet_obj_2 = CronetEngine_Activity.addPublicKeyPins.call(this, hostName, pinsSha256, includeSubdomains, expirationDate);
                return cronet_obj_2;
            };
    } catch (err) { }
    try {
        var HttpCertificatePinning_Activity = Java.use('diefferson.http_certificate_pinning.HttpCertificatePinning');
        HttpCertificatePinning_Activity.checkConnexion.overload("java.lang.String", "java.util.List", "java.util.Map", "int", "java.lang.String")
            .implementation = function (a, b, c, d, e) {
                console.log('[+] Bypassing Flutter HttpCertificatePinning : ' + a);
                return true;
            };
    } catch (err) { }
    try {
        var SslPinningPlugin_Activity = Java.use('com.macif.plugin.sslpinningplugin.SslPinningPlugin');
        SslPinningPlugin_Activity.checkConnexion.overload("java.lang.String", "java.util.List", "java.util.Map", "int", "java.lang.String")
            .implementation = function (a, b, c, d, e) {
                console.log('[+] Bypassing Flutter SslPinningPlugin: ' + a);
                return true;
            };
    } catch (err) { }

    function rudimentaryFix(typeName) {
        if (typeName === undefined) {
            return;
        } else if (typeName === 'boolean') {
            return true;
        } else {
            return null;
        }
    }
    try {
        var UnverifiedCertError = Java.use('javax.net.ssl.SSLPeerUnverifiedException');
        UnverifiedCertError.$init.implementation = function (str) {
            console.log('[!] Unexpected SSLPeerUnverifiedException occurred, trying to patch it dynamically...!');
            try {
                var stackTrace = Java.use('java.lang.Thread')
                    .currentThread()
                    .getStackTrace();
                var exceptionStackIndex = stackTrace.findIndex(stack => stack.getClassName() === "javax.net.ssl.SSLPeerUnverifiedException");
                var callingFunctionStack = stackTrace[exceptionStackIndex + 1];
                var className = callingFunctionStack.getClassName();
                var methodName = callingFunctionStack.getMethodName();
                var callingClass = Java.use(className);
                var callingMethod = callingClass[methodName];
                console.log('[!] Attempting to bypass uncommon SSL Pinning method on: ' + className + '.' + methodName + '!');
                if (callingMethod.implementation) {
                    return;
                }
                var returnTypeName = callingMethod.returnType.type;
                callingMethod.implementation = function () {
                    rudimentaryFix(returnTypeName);
                };
            } catch (e) {
                if (String(e)
                    .includes(".overload")) {
                    var splittedList = String(e)
                        .split(".overload");
                    for (let i = 2; i < splittedList.length; i++) {
                        var extractedOverload = splittedList[i].trim()
                            .split("(")[1].slice(0, -1)
                            .replaceAll("'", "");
                        if (extractedOverload.includes(",")) {
                            var argList = extractedOverload.split(", ");
                            console.log('[!] Attempting overload of ' + className + '.' + methodName + ' with arguments: ' + extractedOverload + '!');
                            if (argList.length == 2) {
                                callingMethod.overload(argList[0], argList[1])
                                    .implementation = function (a, b) {
                                        rudimentaryFix(returnTypeName);
                                    }
                            } else if (argNum == 3) {
                                callingMethod.overload(argList[0], argList[1], argList[2])
                                    .implementation = function (a, b, c) {
                                        rudimentaryFix(returnTypeName);
                                    }
                            } else if (argNum == 4) {
                                callingMethod.overload(argList[0], argList[1], argList[2], argList[3])
                                    .implementation = function (a, b, c, d) {
                                        rudimentaryFix(returnTypeName);
                                    }
                            } else if (argNum == 5) {
                                callingMethod.overload(argList[0], argList[1], argList[2], argList[3], argList[4])
                                    .implementation = function (a, b, c, d, e) {
                                        rudimentaryFix(returnTypeName);
                                    }
                            } else if (argNum == 6) {
                                callingMethod.overload(argList[0], argList[1], argList[2], argList[3], argList[4], argList[5])
                                    .implementation = function (a, b, c, d, e, f) {
                                        rudimentaryFix(returnTypeName);
                                    }
                            }
                        } else {
                            callingMethod.overload(extractedOverload)
                                .implementation = function (a) {
                                    rudimentaryFix(returnTypeName);
                                }
                        }
                    }
                } else {
                    console.log('[-] Failed to dynamically patch SSLPeerUnverifiedException ' + e + '!');
                }
            }
            return this.$init(str);
        };
    } catch (err) { }
}
setTimeout(function () {
    Java.perform(function () {

        var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
        var SSLContext = Java.use('javax.net.ssl.SSLContext');

        var TrustManager = Java.registerClass({
            name: 'incogbyte.bypass.test.TrustManager',
            implements: [X509TrustManager],
            methods: {
                checkClientTrusted: function (chain, authType) { },
                checkServerTrusted: function (chain, authType) { },
                getAcceptedIssuers: function () {
                    return [];
                }
            }
        });

        dynamicPatching();
        CommonMethods();
        try {
            var okhttp3_Activity = Java.use('okhttp3.CertificatePinner');
            okhttp3_Activity.check.overload('java.lang.String', 'java.util.List')
                .implementation = function (str) {
                    console.log('[+] Bypassing OkHTTPv3 {1}: ' + str);
                };
            okhttp3_Activity.check.overload('java.lang.String', 'java.security.cert.Certificate')
                .implementation = function (str) {
                    console.log('[+] Bypassing OkHTTPv3 {2}: ' + str);
                };
            console.log('[+] okhttp3 Pinning')
        } catch (err) { }
        try {
            var trustkit_Activity = Java.use('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier');
            trustkit_Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
                .implementation = function (str) {
                    console.log('[+] Bypassing Trustkit {1}: ' + str);
                    return true;
                };
            trustkit_Activity.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
                .implementation = function (str) {
                    console.log('[+] Bypassing Trustkit {2}: ' + str);
                    return true;
                };
            var trustkit_PinningTrustManager = Java.use('com.datatheorem.android.trustkit.pinning.PinningTrustManager');
            trustkit_PinningTrustManager.checkServerTrusted.implementation = function () {
                console.log('[+] Bypassing Trustkit {3}');
            };
            console.log('[+] Trustkit Pinning')
        } catch (err) { }
        try {
            var TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
            TrustManagerImpl.verifyChain.implementation = function (untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
                console.log('[+] Bypassing TrustManagerImpl (Android > 7): ' + host);
                return untrustedChain;
            };
        } catch (err) { }
        try {
            var appcelerator_PinningTrustManager = Java.use('appcelerator.https.PinningTrustManager');
            appcelerator_PinningTrustManager.checkServerTrusted.implementation = function () {
                console.log('[+] Bypassing Appcelerator PinningTrustManager');
            };
            console.log('[+] Appcelerator PinningTrustManager')
        } catch (err) { }
        try {
            var OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
            OpenSSLSocketImpl.verifyCertificateChain.implementation = function (certRefs, JavaObject, authMethod) {
                console.log('[+] Bypassing OpenSSLSocketImpl Conscrypt');
            };
            console.log('[+] OpenSSLSocketImpl Conscrypt')
        } catch (err) { }
        try {
            var OpenSSLEngineSocketImpl_Activity = Java.use('com.android.org.conscrypt.OpenSSLEngineSocketImpl');
            OpenSSLEngineSocketImpl_Activity.verifyCertificateChain.overload('[Ljava.lang.Long;', 'java.lang.String')
                .implementation = function (str1, str2) {
                    console.log('[+] Bypassing OpenSSLEngineSocketImpl Conscrypt: ' + str2);
                };
            console.log('[+] OpenSSLEngineSocketImpl Conscrypt')
        } catch (err) { }
        try {
            var OpenSSLSocketImpl_Harmony = Java.use('org.apache.harmony.xnet.provider.jsse.OpenSSLSocketImpl');
            OpenSSLSocketImpl_Harmony.verifyCertificateChain.implementation = function (asn1DerEncodedCertificateChain, authMethod) {
                console.log('[+] Bypassing OpenSSLSocketImpl Apache Harmony');
            };
            console.log('[+] OpenSSLSocketImpl Apache Harmony')
        } catch (err) { }
        try {
            var phonegap_Activity = Java.use('nl.xservices.plugins.sslCertificateChecker');
            phonegap_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
                .implementation = function (str) {
                    console.log('[+] Bypassing PhoneGap sslCertificateChecker: ' + str);
                    return true;
                };
            console.log('[+] PhoneGap sslCertificateChecker')
        } catch (err) { }
        try {
            var WLClient_Activity = Java.use('com.worklight.wlclient.api.WLClient');
            WLClient_Activity.getInstance()
                .pinTrustedCertificatePublicKey.overload('java.lang.String')
                .implementation = function (cert) {
                    console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey {1}: ' + cert);
                    return;
                };
            WLClient_Activity.getInstance()
                .pinTrustedCertificatePublicKey.overload('[Ljava.lang.String;')
                .implementation = function (cert) {
                    console.log('[+] Bypassing IBM MobileFirst pinTrustedCertificatePublicKey {2}: ' + cert);
                    return;
                };
            console.log('[+] IBM MobileFirst Pinning')
        } catch (err) { }
        try {
            var worklight_Activity = Java.use('com.worklight.wlclient.certificatepinning.HostNameVerifierWithCertificatePinning');
            worklight_Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSocket')
                .implementation = function (str) {
                    console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {1}: ' + str);
                    return;
                };
            worklight_Activity.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
                .implementation = function (str) {
                    console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {2}: ' + str);
                    return;
                };
            worklight_Activity.verify.overload('java.lang.String', '[Ljava.lang.String;', '[Ljava.lang.String;')
                .implementation = function (str) {
                    console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {3}: ' + str);
                    return;
                };
            worklight_Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
                .implementation = function (str) {
                    console.log('[+] Bypassing IBM WorkLight HostNameVerifierWithCertificatePinning {4}: ' + str);
                    return true;
                };
            console.log('[+] IBM WorkLight Pinning')
        } catch (err) { }
        try {
            var conscrypt_CertPinManager_Activity = Java.use('com.android.org.conscrypt.CertPinManager');
            conscrypt_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
                .implementation = function (str) {
                    console.log('[+] Bypassing Conscrypt CertPinManager: ' + str);
                    return true;
                };
            console.log('[+] Conscrypt CertPinManager')
        } catch (err) { }
        try {
            var cwac_CertPinManager_Activity = Java.use('com.commonsware.cwac.netsecurity.conscrypt.CertPinManager');
            cwac_CertPinManager_Activity.isChainValid.overload('java.lang.String', 'java.util.List')
                .implementation = function (str) {
                    console.log('[+] Bypassing CWAC-Netsecurity CertPinManager: ' + str);
                    return true;
                };
            console.log('[+] CWAC-Netsecurity CertPin')
        } catch (err) { }
        try {
            var androidgap_WLCertificatePinningPlugin_Activity = Java.use('com.worklight.androidgap.plugin.WLCertificatePinningPlugin');
            androidgap_WLCertificatePinningPlugin_Activity.execute.overload('java.lang.String', 'org.json.JSONArray', 'org.apache.cordova.CallbackContext')
                .implementation = function (str) {
                    console.log('[+] Bypassing Worklight Androidgap WLCertificatePinningPlugin: ' + str);
                    return true;
                };
            console.log('[+] Androidgap WLCertificatePinning')
        } catch (err) { }
        try {
            var Squareup_CertificatePinner_Activity = Java.use('com.squareup.okhttp.CertificatePinner');
            Squareup_CertificatePinner_Activity.check.overload('java.lang.String', 'java.security.cert.Certificate')
                .implementation = function (str1, str2) {
                    console.log('[+] Bypassing Squareup CertificatePinner {1}: ' + str1);
                    return;
                };
            Squareup_CertificatePinner_Activity.check.overload('java.lang.String', 'java.util.List')
                .implementation = function (str1, str2) {
                    console.log('[+] Bypassing Squareup CertificatePinner {2}: ' + str1);
                    return;
                };
            console.log('[+] Squareup CertificatePinner')
        } catch (err) { }
        try {
            var Squareup_OkHostnameVerifier_Activity = Java.use('com.squareup.okhttp.internal.tls.OkHostnameVerifier');
            Squareup_OkHostnameVerifier_Activity.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
                .implementation = function (str1, str2) {
                    console.log('[+] Bypassing Squareup OkHostnameVerifier {1}: ' + str1);
                    return true;
                };
            Squareup_OkHostnameVerifier_Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
                .implementation = function (str1, str2) {
                    console.log('[+] Bypassing Squareup OkHostnameVerifier {2}: ' + str1);
                    return true;
                };
            console.log('[+] Squareup OkHostnameVerifier Pinning')
        } catch (err) { }
        try {
            var AndroidWebViewClient_Activity = Java.use('android.webkit.WebViewClient');
            AndroidWebViewClient_Activity.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
                .implementation = function (obj1, obj2, obj3) {
                    console.log('[+] Bypassing Android WebViewClient');
                };
            console.log('[+] Android Webkit WebViewClient Pinning')
        } catch (err) { }
        try {
            var CordovaWebViewClient_Activity = Java.use('org.apache.cordova.CordovaWebViewClient');
            CordovaWebViewClient_Activity.onReceivedSslError.overload('android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError')
                .implementation = function (obj1, obj2, obj3) {
                    console.log('[+] Bypassing Apache Cordova WebViewClient');
                    obj3.proceed();
                };
            console.log('[+] CordovaWebViewClient Pinning')
        } catch (err) { }
        try {
            var boye_AbstractVerifier = Java.use('ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier');
            boye_AbstractVerifier.verify.implementation = function (host, ssl) {
                console.log('[+] Bypassing Boye AbstractVerifier: ' + host);
            };
            console.log('[+] Boye Pinning')
        } catch (err) { }
        try {
            var TrustManagerImpl = Java.use("com.android.org.conscrypt.TrustManagerImpl");
            TrustManagerImpl.verifyChain.implementation = function (untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
                console.log("[+] TrustManagerImpl verifyChain called");
                return untrustedChain;
            }
            console.log('[+] Conscrypt TrustManagerImpl pinning')
        } catch (e) { }
        try {
            var OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
            OpenSSLSocketImpl.verifyCertificateChain.implementation = function (certRefs, authMethod) {
                console.log('    OpenSSLSocketImpl.verifyCertificateChain');
            }
            console.log('[+] OpenSSLSocketImpl pinning')
        } catch (err) { }
        try {
            var Activity = Java.use("com.datatheorem.android.trustkit.pinning.OkHostnameVerifier");
            Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession')
                .implementation = function (str) {
                    console.log('    Trustkit.verify1: ' + str);
                    return true;
                };
            Activity.verify.overload('java.lang.String', 'java.security.cert.X509Certificate')
                .implementation = function (str) {
                    console.log('    Trustkit.verify2: ' + str);
                    return true;
                };
            console.log('[+] Trustkit pinning')
        } catch (err) { }
        try {
            var netBuilder = Java.use("org.chromium.net.CronetEngine$Builder");
            netBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.implementation = function (arg) {
                console.log("    Enables or disables public key pinning bypass for local trust anchors = " + arg);
                var ret = netBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.call(this, true);
                return ret;
            };
            netBuilder.addPublicKeyPins.implementation = function (hostName, pinsSha256, includeSubdomains, expirationDate) {
                console.log("[+] Cronet addPublicKeyPins hostName = " + hostName);
                return this;
            };
            console.log('[+] Cronet pinning')
        } catch (err) { }
    });
}, 0);

```

或如下脚本

```cpp

var DroidSSLUnpinning = function(){

function klog(data){
    var message={};
    message["jsname"]="DroidSSLUnpinning";
    message["data"]=data;
    console.log("DroidSSLUnpinning", data);
}

Java.perform(function() {
    console.log("DroidSSLUnpinning","init","DroidSSLUnpinning.js init hook success")
/*
hook list:
1.SSLcontext
2.okhttp
3.webview
4.XUtils
5.httpclientandroidlib
6.JSSE
7.network\_security\_config (android 7.0+)
8.Apache Http client (support partly)
9.OpenSSLSocketImpl
10.TrustKit
11.Cronet
*/

	// Attempts to bypass SSL pinning implementations in a number of
	// ways. These include implementing a new TrustManager that will
	// accept any SSL certificate, overriding OkHTTP v3 check()
	// method etc.
	var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
	var HostnameVerifier = Java.use('javax.net.ssl.HostnameVerifier');
	var SSLContext = Java.use('javax.net.ssl.SSLContext');
	var quiet_output = false;

	// Helper method to honor the quiet flag.

	function quiet_send(data) {

		if (quiet_output) {
			return;
		}
		klog(data);
	}


	// Implement a new TrustManager
	// ref: https://gist.github.com/oleavr/3ca67a173ff7d207c6b8c3b0ca65a9d8
	// Java.registerClass() is only supported on ART for now(201803). 所以android 4.4以下不兼容,4.4要切换成ART使用.
	/*
06-07 16:15:38.541 27021-27073/mi.sslpinningdemo W/System.err: java.lang.IllegalArgumentException: Required method checkServerTrusted(X509Certificate[], String, String, String) missing
06-07 16:15:38.542 27021-27073/mi.sslpinningdemo W/System.err:     at android.net.http.X509TrustManagerExtensions.<init>(X509TrustManagerExtensions.java:73)
        at mi.ssl.MiPinningTrustManger.<init>(MiPinningTrustManger.java:61)
06-07 16:15:38.543 27021-27073/mi.sslpinningdemo W/System.err:     at mi.sslpinningdemo.OkHttpUtil.getSecPinningClient(OkHttpUtil.java:112)
        at mi.sslpinningdemo.OkHttpUtil.get(OkHttpUtil.java:62)
        at mi.sslpinningdemo.MainActivity$1$1.run(MainActivity.java:36)
*/
	var X509Certificate = Java.use("java.security.cert.X509Certificate");
	var TrustManager;
	try {
		TrustManager = Java.registerClass({
			name: 'org.wooyun.TrustManager',
			implements: [X509TrustManager],
			methods: {
				checkClientTrusted: function(chain, authType) {},
				checkServerTrusted: function(chain, authType) {},
				getAcceptedIssuers: function() {
					// var certs = [X509Certificate.$new()];
					// return certs;
					return [];
				}
			}
		});
	} catch (e) {
		quiet_send("registerClass from X509TrustManager >>>>>>>> " + e.message);
	}





	// Prepare the TrustManagers array to pass to SSLContext.init()
	var TrustManagers = [TrustManager.$new()];

	try {
		// Prepare a Empty SSLFactory
		var TLS_SSLContext = SSLContext.getInstance("TLS");
		TLS_SSLContext.init(null, TrustManagers, null);
		var EmptySSLFactory = TLS_SSLContext.getSocketFactory();
	} catch (e) {
		quiet_send(e.message);
	}

	quiet_send('Custom, Empty TrustManager ready');

	// Get a handle on the init() on the SSLContext class
	var SSLContext_init = SSLContext.init.overload(
		'[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');

	// Override the init method, specifying our new TrustManager
	SSLContext_init.implementation = function(keyManager, trustManager, secureRandom) {

		quiet_send('Overriding SSLContext.init() with the custom TrustManager');

		SSLContext_init.call(this, null, TrustManagers, null);
	};

	/*** okhttp3.x unpinning ***/


	// Wrap the logic in a try/catch as not all applications will have
	// okhttp as part of the app.
	try {

		var CertificatePinner = Java.use('okhttp3.CertificatePinner');

		quiet_send('OkHTTP 3.x Found');

		CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function() {

			quiet_send('OkHTTP 3.x check() called. Not throwing an exception.');
		}

	} catch (err) {

		// If we dont have a ClassNotFoundException exception, raise the
		// problem encountered.
		if (err.message.indexOf('ClassNotFoundException') === 0) {

			throw new Error(err);
		}
	}

	// Appcelerator Titanium PinningTrustManager

	// Wrap the logic in a try/catch as not all applications will have
	// appcelerator as part of the app.
	try {

		var PinningTrustManager = Java.use('appcelerator.https.PinningTrustManager');
		quiet_send('Appcelerator Titanium Found')

		PinningTrustManager.checkServerTrusted.implementation = function() {

			quiet_send('Appcelerator checkServerTrusted() called. Not throwing an exception.');
		}

	} catch (err) {

		// If we dont have a ClassNotFoundException exception, raise the
		// problem encountered.
		if (err.message.indexOf('ClassNotFoundException') === 0) {

			throw new Error(err);
		}
	}

	/*** okhttp unpinning ***/


	try {
		var OkHttpClient = Java.use("com.squareup.okhttp.OkHttpClient");
		OkHttpClient.setCertificatePinner.implementation = function(certificatePinner) {
			// do nothing
			quiet_send("OkHttpClient.setCertificatePinner Called!");
			return this;
		};

		// Invalidate the certificate pinnet checks (if "setCertificatePinner" was called before the previous invalidation)
		var CertificatePinner = Java.use("com.squareup.okhttp.CertificatePinner");
		CertificatePinner.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;').implementation = function(p0, p1) {
			// do nothing
			quiet_send("okhttp Called! [Certificate]");
			return;
		};
		CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function(p0, p1) {
			// do nothing
			quiet_send("okhttp Called! [List]");
			return;
		};
	} catch (e) {
		quiet_send("com.squareup.okhttp not found");
	}

	/*** WebView Hooks ***/

	/* frameworks/base/core/java/android/webkit/WebViewClient.java */
	/* public void onReceivedSslError(Webview, SslErrorHandler, SslError) */
	var WebViewClient = Java.use("android.webkit.WebViewClient");

	WebViewClient.onReceivedSslError.implementation = function(webView, sslErrorHandler, sslError) {
		quiet_send("WebViewClient onReceivedSslError invoke");
		//执行proceed方法
		sslErrorHandler.proceed();
		return;
	};

	WebViewClient.onReceivedError.overload('android.webkit.WebView', 'int', 'java.lang.String', 'java.lang.String').implementation = function(a, b, c, d) {
		quiet_send("WebViewClient onReceivedError invoked");
		return;
	};

	WebViewClient.onReceivedError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError').implementation = function() {
		quiet_send("WebViewClient onReceivedError invoked");
		return;
	};

	/*** JSSE Hooks ***/

	/* libcore/luni/src/main/java/javax/net/ssl/TrustManagerFactory.java */
	/* public final TrustManager[] getTrustManager() */
	/* TrustManagerFactory.getTrustManagers maybe cause X509TrustManagerExtensions error  */
	// var TrustManagerFactory = Java.use("javax.net.ssl.TrustManagerFactory");
	// TrustManagerFactory.getTrustManagers.implementation = function(){
	//     quiet_send("TrustManagerFactory getTrustManagers invoked");
	//     return TrustManagers;
	// }

	var HttpsURLConnection = Java.use("javax.net.ssl.HttpsURLConnection");
	/* libcore/luni/src/main/java/javax/net/ssl/HttpsURLConnection.java */
	/* public void setDefaultHostnameVerifier(HostnameVerifier) */
	HttpsURLConnection.setDefaultHostnameVerifier.implementation = function(hostnameVerifier) {
		quiet_send("HttpsURLConnection.setDefaultHostnameVerifier invoked");
		return null;
	};
	/* libcore/luni/src/main/java/javax/net/ssl/HttpsURLConnection.java */
	/* public void setSSLSocketFactory(SSLSocketFactory) */
	HttpsURLConnection.setSSLSocketFactory.implementation = function(SSLSocketFactory) {
		quiet_send("HttpsURLConnection.setSSLSocketFactory invoked");
		return null;
	};
	/* libcore/luni/src/main/java/javax/net/ssl/HttpsURLConnection.java */
	/* public void setHostnameVerifier(HostnameVerifier) */
	HttpsURLConnection.setHostnameVerifier.implementation = function(hostnameVerifier) {
		quiet_send("HttpsURLConnection.setHostnameVerifier invoked");
		return null;
	};

	/*** Xutils3.x hooks ***/
	//Implement a new HostnameVerifier
	var TrustHostnameVerifier;
	try {
		TrustHostnameVerifier = Java.registerClass({
			name: 'org.wooyun.TrustHostnameVerifier',
			implements: [HostnameVerifier],
			method: {
				verify: function(hostname, session) {
					return true;
				}
			}
		});

	} catch (e) {
		//java.lang.ClassNotFoundException: Didn't find class "org.wooyun.TrustHostnameVerifier"
		quiet_send("registerClass from hostnameVerifier >>>>>>>> " + e.message);
	}

	try {
		var RequestParams = Java.use('org.xutils.http.RequestParams');
		RequestParams.setSslSocketFactory.implementation = function(sslSocketFactory) {
			sslSocketFactory = EmptySSLFactory;
			return null;
		}

		RequestParams.setHostnameVerifier.implementation = function(hostnameVerifier) {
			hostnameVerifier = TrustHostnameVerifier.$new();
			return null;
		}

	} catch (e) {
		quiet_send("Xutils hooks not Found");
	}

	/*** httpclientandroidlib Hooks ***/
	try {
		var AbstractVerifier = Java.use("ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier");
		AbstractVerifier.verify.overload('java.lang.String', '[Ljava.lang.String', '[Ljava.lang.String', 'boolean').implementation = function() {
			quiet_send("httpclientandroidlib Hooks");
			return null;
		}
	} catch (e) {
		quiet_send("httpclientandroidlib Hooks not found");
	}

	/***
android 7.0+ network_security_config TrustManagerImpl hook
apache httpclient partly
***/
	var TrustManagerImpl = Java.use("com.android.org.conscrypt.TrustManagerImpl");
	// try {
	//     var Arrays = Java.use("java.util.Arrays");
	//     //apache http client pinning maybe baypass
	//     //https://github.com/google/conscrypt/blob/c88f9f55a523f128f0e4dace76a34724bfa1e88c/platform/src/main/java/org/conscrypt/TrustManagerImpl.java#471
	//     TrustManagerImpl.checkTrusted.implementation = function (chain, authType, session, parameters, authType) {
	//         quiet_send("TrustManagerImpl checkTrusted called");
	//         //Generics currently result in java.lang.Object
	//         return Arrays.asList(chain);
	//     }
	//
	// } catch (e) {
	//     quiet_send("TrustManagerImpl checkTrusted nout found");
	// }

	try {
		// Android 7+ TrustManagerImpl
		TrustManagerImpl.verifyChain.implementation = function(untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
			quiet_send("TrustManagerImpl verifyChain called");
			// Skip all the logic and just return the chain again :P
			//https://www.nccgroup.trust/uk/about-us/newsroom-and-events/blogs/2017/november/bypassing-androids-network-security-configuration/
			// https://github.com/google/conscrypt/blob/c88f9f55a523f128f0e4dace76a34724bfa1e88c/platform/src/main/java/org/conscrypt/TrustManagerImpl.java#L650
			return untrustedChain;
		}
	} catch (e) {
		quiet_send("TrustManagerImpl verifyChain nout found below 7.0");
	}
	// OpenSSLSocketImpl
	try {
		var OpenSSLSocketImpl = Java.use('com.android.org.conscrypt.OpenSSLSocketImpl');
		OpenSSLSocketImpl.verifyCertificateChain.implementation = function(certRefs, authMethod) {
			quiet_send('OpenSSLSocketImpl.verifyCertificateChain');
		}

		quiet_send('OpenSSLSocketImpl pinning')
	} catch (err) {
		quiet_send('OpenSSLSocketImpl pinner not found');
	}
	// Trustkit
	try {
		var Activity = Java.use("com.datatheorem.android.trustkit.pinning.OkHostnameVerifier");
		Activity.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession').implementation = function(str) {
			quiet_send('Trustkit.verify1: ' + str);
			return true;
		};
		Activity.verify.overload('java.lang.String', 'java.security.cert.X509Certificate').implementation = function(str) {
			quiet_send('Trustkit.verify2: ' + str);
			return true;
		};

		quiet_send('Trustkit pinning')
	} catch (err) {
		quiet_send('Trustkit pinner not found')
	}

	try {
		//cronet pinner hook
		//weibo don't invoke

		var netBuilder = Java.use("org.chromium.net.CronetEngine$Builder");

		//https://developer.android.com/guide/topics/connectivity/cronet/reference/org/chromium/net/CronetEngine.Builder.html#enablePublicKeyPinningBypassForLocalTrustAnchors(boolean)
		netBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.implementation = function(arg) {

			//weibo not invoke
			// console.log("Enables or disables public key pinning bypass for local trust anchors = " + arg);
			quiet_send("Enables or disables public key pinning bypass for local trust anchors = " + arg);
			//true to enable the bypass, false to disable.
			var ret = netBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.call(this, true);
			return ret;
		};

		netBuilder.addPublicKeyPins.implementation = function(hostName, pinsSha256, includeSubdomains, expirationDate) {
			// console.log("cronet addPublicKeyPins hostName = " + hostName);
			quiet_send("cronet addPublicKeyPins hostName = " + hostName);
			//var ret = netBuilder.addPublicKeyPins.call(this,hostName, pinsSha256,includeSubdomains, expirationDate);
			//this 是调用 addPublicKeyPins 前的对象吗? Yes,CronetEngine.Builder
			return this;
		};

	} catch (err) {
		// console.log('[-] Cronet pinner not found')
		quiet_send('[-] Cronet pinner not found')
	}
});
}

setImmediate(DroidSSLUnpinning);


```

使用后发现依然过不了证书验证，存在服务端校验客户端证书逻辑

使用r0capture将证书和密码dump下载/或使用其他frida脚本都可

例如tracer-keystore.js等[https://raw.githubusercontent.com/m0bilesecurity/Frida-Mobile-Scripts/master/Android/tracer_keystore.js](https://raw.githubusercontent.com/m0bilesecurity/Frida-Mobile-Scripts/master/Android/tracer_keystore.js)



以r0为例[https://github.com/r0ysue/r0capture](https://github.com/r0ysue/r0capture)

clone项目后运行 py .\r0capture.py -U 应用名 -v

证书被自动存储到sd卡 和密码被设置为r0ysue

![图片](/img/frida/f9a799a43dcb3ece/1754819712146-efc408c8-eccd-459d-b58d-65f3d0eb115c-408724.png)

以tracer-keystore.js脚本为例 运行后点击触发即可显示密码，可从Stream流下载证书，也可解包从静态文件中取出

![图片](/img/frida/f9a799a43dcb3ece/1754819907724-0cdddddc-195f-4428-b15f-3930e8ddcffb-759868.png)

安卓默认的是BKS格式的证书需要转成xx.p12格式的来使用，使用工具KeyStore Explorer进行格式转换[https://github.com/kaikramer/keystore-explorer/releases](https://github.com/kaikramer/keystore-explorer/releases) 使用v5.51版本 新版本5.5有bug会读取失败



将转换后的p12证书加载到charless后配合ssl unpinning一起使用可用过双向验证

![图片](/img/frida/f9a799a43dcb3ece/1754820272145-59fd9809-ee49-48d9-883b-52b0efbcd169-222498.png)

添加地址端口和证书及其密码

![图片](/img/frida/f9a799a43dcb3ece/1754820303418-8035b568-63e7-4040-bcfe-dce706a5e990-443601.png)

不知道端口可使用r0capture脚本hook来查看端口和具体地址，或者反编译apk找到端口

![图片](/img/frida/f9a799a43dcb3ece/1754820470753-d2580210-fe65-41b3-89fc-7900e390123e-356488.png)

最终charless抓包演示（证书+ssl unpinning脚本）

![图片](/img/frida/f9a799a43dcb3ece/1754820608034-55f0c899-409f-4b0e-8efa-8b8fa92594ba-939654.png)

最终通过脚本进行数据获取（读取p12证书，因为不在app中不需要过校验服务器证书的逻辑）

```python
import requests_pkcs12

def get_page(page):
    url = 'https://47.95.8.136:8443/api/app9'
    hd = {
        'Content-Type':'application/x-www-form-urlencoded',
        'user-agent': 'okhttp/3.14.9'
    }
    data = {
        'page': page
    }
    resp = requests_pkcs12.post(url,
        headers=hd, data=data, pkcs12_filename='C://Users//kugua//Desktop//1.p12',
        pkcs12_password='MZ4cozY8Qu32UzGe', verify=False)
    return resp.json()

sum = 0

for i in range(1, 101):
    data = get_page(i)['data']
    for v in data:
        sum += int(v['value'])

print(sum)
```





> 更新: 2025-08-10 18:28:57  
> 原文: <https://www.yuque.com/kugua-4bekq/aqsx38/ostwpnmmgd01y60n>