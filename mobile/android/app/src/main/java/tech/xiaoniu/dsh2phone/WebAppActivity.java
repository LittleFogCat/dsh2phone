package tech.xiaoniu.dsh2phone;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 全屏 WebView：不再渲染原生 Toolbar，页面占满状态栏以下区域；状态栏/导航栏颜色
 * 跟随 DSH 页面背景（读 computed style），图标明暗随背景亮度切换。
 *
 * 键盘：首屏自动聚焦的输入框会被短暂压制（clearFocus + JS focus guard），
 * 用户主动触摸后不再压制；IME insets 直接变成根布局底部 padding，弹出即让页面整体上移。
 */
public final class WebAppActivity extends AppCompatActivity {
    private static final String PAGE_BG_JS =
            "(function(){try{var b=document.body,c=b?getComputedStyle(b).backgroundColor:'';"
                    + "if(!c||c==='rgba(0, 0, 0, 0)'||c==='transparent'){var d=document.documentElement;"
                    + "c=d?getComputedStyle(d).backgroundColor:'';}return c||'';}catch(e){return '';}})()";
    private static final String THEME_SEND_JS =
            "(function(){"
                    + "if(window.__dsh2phoneHooksInstalled){try{window.__dsh2phoneThemeUpdate&&window.__dsh2phoneThemeUpdate();}catch(e){}return;}"
                    + "var bridge=window.Dsh2PhoneNative;if(!bridge)return;"
                    + "window.__dsh2phoneHooksInstalled=true;"
                    + "function opaque(c){return !!c&&c!=='transparent'&&c!=='rgba(0, 0, 0, 0)';}"
                    + "function at(x,y){try{var el=document.elementFromPoint(x,y);"
                    + "for(var i=0;el&&i<8;i++,el=el.parentElement){var c=getComputedStyle(el).backgroundColor;"
                    + "if(opaque(c))return c;}}catch(e){}return '';}"
                    + "function bg(){try{var c=at(innerWidth*0.5,6);if(!opaque(c))c=at(innerWidth*0.18,6);"
                    + "if(!opaque(c))c=at(innerWidth*0.82,6);if(!opaque(c))c=at(innerWidth*0.5,innerHeight*0.35);"
                    + "if(!opaque(c)){var b=document.body,d=document.documentElement;"
                    + "c=b?getComputedStyle(b).backgroundColor:'';"
                    + "if(!opaque(c))c=d?getComputedStyle(d).backgroundColor:'';}return c||'';}catch(e){return '';}}"
                    + "var last='';"
                    + "function update(){try{var c=bg();if(c&&c!==last){last=c;bridge.setPageBackground(c);}}catch(e){}}"
                    + "window.__dsh2phoneThemeUpdate=update;update();"
                    + "try{new MutationObserver(update).observe(document.documentElement,"
                    + "{attributes:true,subtree:true,attributeFilter:['style','class']});}catch(e){}"
                    + "var n=0,iv=setInterval(function(){update();if(++n>120)clearInterval(iv);},500);"
                    + "document.addEventListener('visibilitychange',update);"
                    + "window.addEventListener('hashchange',update);window.addEventListener('popstate',update);"
                    + "function hide(){try{bridge.hideKeyboard();}catch(e){}}"
                    + "document.addEventListener('keydown',function(e){"
                    + "if(e.key!=='Enter'||e.shiftKey||e.altKey||e.isComposing)return;"
                    // 有些 WebView/IME 组合下 Enter 的 event.target 是 body，activeElement
                    // 也不可靠；用“键盘弹出时按 Enter 即视为发送/提交”来收键盘。
                    + "setTimeout(hide,50);"
                    + "},true);"
                    + "document.addEventListener('submit',function(){setTimeout(hide,60);},true);"
                    + "document.addEventListener('click',function(e){var el=e.target;"
                    // 短按（非输入框）即视为离开输入态：发送按钮、工具栏、空白处都收键盘；
                    // 长按选择/滑动不会触发 click。点输入框本身不隐藏。
                    + "try{var te=e.target;var editable=te&&(te.tagName==='INPUT'||te.tagName==='TEXTAREA'||te.isContentEditable);"
                    // 按钮/菜单触发器的 click 不能收键盘，否则弹出层会因 WebView 失焦/IME 收起而闪退。
                    + "var action=te&&te.closest&&te.closest('button,a,[role=\"button\"],[role=\"menuitem\"],[aria-haspopup=\"true\"]');"
                    + "if(!editable&&!action)setTimeout(hide,80);}catch(_){ }"
                    + "for(var i=0;el&&i<6;i++,el=el.parentElement){var label='';"
                    + "try{label=((el.getAttribute&&(el.getAttribute('aria-label')||'')||'')"
                    + "+' '+(el.getAttribute&&(el.getAttribute('title')||'')||'')"
                    + "+' '+(el.textContent||'')).trim().slice(0,80);}catch(_){ }"
                    + "if(label&&/发送|send|提交/i.test(label)"
                    + "&&(el.tagName==='BUTTON'||el.getAttribute('role')==='button'||el.tagName==='A'))"
                    + "{setTimeout(hide,120);break;}}}"
                    + ",true);"
                    + "})()";

    private static final String FOCUS_GUARD_JS =
            "(function(){if(window.__dsh2phoneFocusGuard)return;window.__dsh2phoneFocusGuard=true;"
                    + "var a=document.activeElement;"
                    + "if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){try{a.blur();}catch(_){}}"
                    + "var unlocked=false,iv=null;"
                    + "function unlock(){unlocked=true;if(iv){clearInterval(iv);iv=null;}"
                    + "document.removeEventListener('touchstart',unlock,true);"
                    + "document.removeEventListener('mousedown',unlock,true);}"
                    + "document.addEventListener('touchstart',unlock,true);"
                    + "document.addEventListener('mousedown',unlock,true);"
                    + "document.addEventListener('focusin',function(e){if(unlocked)return;var t=e.target;"
                    + "if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)){"
                    + "setTimeout(function(){try{t.blur();}catch(_){}},0);}},true);"
                    // 有些 WebView 的 autofocus 发生在 focusin 监听安装之后且不触发事件，
                    // 前 4 秒再低频兜底清除焦点；用户一触摸就解锁，不会干扰输入。
                    + "iv=setInterval(function(){if(unlocked){clearInterval(iv);iv=null;return;}"
                    + "var a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){"
                    + "try{a.blur();}catch(_){}}},150);"
                    + "setTimeout(function(){clearInterval(iv);},4000);})()";

    private PairStore store;
    private Pairing pairing;

    private FrameLayout webRoot;
    private WebView webView;
    private ProgressBar progress;
    private MaterialCardView banner;
    private TextView bannerText;
    private MaterialButton bannerAction;

    /** 正在等页面回话（关浮层），避免连按返回键连续关掉多层。 */
    private boolean backPending;
    private final Runnable backTimeout = () -> {
        if (!backPending) return;
        backPending = false;
        backFallback();
    };

    /**
     * 返回键在页面侧的处理：DSH 的 Web GUI 是单路由 + 浮层，**不写 URL 历史**
     * （前端没有 pushState/replaceState，所以 WebView 的 canGoBack() 恒为 false），
     * 「后退」在语义上就是「关掉最上面那层浮层」。
     *
     * 选择器沿用 DSH 前端自己的浮层契约（`[role=dialog][aria-modal=true]` / `[role=menu]`，
     * 见其 modal 栈实现），插件的配对弹窗同样是 `role=dialog aria-modal=true`。
     * 关闭方式也沿用 DSH 的 Escape 约定：向最上层可见浮层派发一个冒泡的 Escape
     * keydown，浏览器事件会冒泡到 document 上的 keydown 监听（DSH 与插件都按这个关）。
     *
     * 返回 true 表示已接管；没有浮层、或同一个浮层连续两次还在（它不认 Escape）
     * 就返回 false，让原生继续走网页历史 / 回主页，避免返回键被卡住。
     */
    private static final String BACK_DISMISS_JS =
            "(function(){try{"
                    + "var sel='[role=dialog][aria-modal=true],[role=alertdialog],[role=menu]';"
                    + "var nodes=document.querySelectorAll(sel),target=null;"
                    + "for(var i=nodes.length-1;i>=0;i--){var el=nodes[i];"
                    + "var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;"
                    + "var cs=getComputedStyle(el);"
                    + "if(cs.visibility==='hidden'||cs.display==='none')continue;"
                    + "var op=parseFloat(cs.opacity);if(!isNaN(op)&&op<=0.01)continue;"
                    + "target=el;break;}"
                    + "if(!target)return false;"
                    + "var id=(target.getAttribute('role')||'')+'|'+String(target.className||'').slice(0,80);"
                    + "var st=window.__dsh2phoneBack||(window.__dsh2phoneBack={});"
                    + "var now=Date.now();"
                    + "if(st.id===id&&now-(st.at||0)<2500)return false;"
                    + "st.id=id;st.at=now;"
                    + "target.dispatchEvent(new KeyboardEvent('keydown',"
                    + "{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));"
                    + "return true;"
                    + "}catch(e){return false;}})()";

    private String entryUrl;
    /** 本次会话实际使用的 origin：直连成功时是 https://ip:port，否则与 pairing.origin 相同。 */
    private String activeOrigin;
    /** 局域网直连入口（null = 未启用 / 已回落公网）。 */
    private String directOrigin;
    private String directFp;
    private boolean lanFallback;
    /** 本次加载是否允许局域网直连；设置页切换后由 onResume 处理。 */
    private boolean lanDirectEnabledAtLoad;
    private boolean sslDialogShown;
    private boolean externalDialogShown;
    private boolean userTouchedPage;
    private ValueCallback<Uri[]> fileCallback;
    private ActivityResultLauncher<Intent> fileChooser;
    private final ExecutorService lanExecutor = Executors.newSingleThreadExecutor();

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final Runnable suppressKeyboard = this::doSuppressKeyboard;
    private final long createdAt = android.os.SystemClock.elapsedRealtime();

    /**
     * 仅 debug：把页面真实传输量/缓存命中数打到 logcat（`adb logcat -s Dsh2PhonePerf`）。
     * 用来区分冷启动是带宽（transferKb 大）还是执行（transferKb 小但耗时长）。
     */
    private static final String PERF_JS =
            "(function(){try{"
                    + "var n=performance.getEntriesByType('navigation')[0]||{};"
                    + "var p=performance.getEntriesByType('paint'),fcp=0;"
                    + "for(var i=0;i<p.length;i++){if(p[i].name==='first-contentful-paint')fcp=Math.round(p[i].startTime);}"
                    + "var rs=performance.getEntriesByType('resource'),tr=0,de=0,ca=0;"
                    + "for(var j=0;j<rs.length;j++){var r=rs[j];tr+=r.transferSize||0;de+=r.decodedBodySize||0;"
                    + "if(!r.transferSize&&r.decodedBodySize)ca++;}"
                    + "return JSON.stringify({now:Math.round(performance.now()),fcp:fcp,"
                    + "dcl:Math.round(n.domContentLoadedEventEnd||0),load:Math.round(n.loadEventEnd||0),"
                    + "req:rs.length,transferKb:Math.round(tr/1024),decodedKb:Math.round(de/1024),cached:ca});"
                    + "}catch(e){return 'ERR '+e;}})()";

    private void logPerf(String phase) {
        if (!isDebugBuild() || webView == null) return;
        long elapsed = android.os.SystemClock.elapsedRealtime() - createdAt;
        webView.evaluateJavascript(PERF_JS, value ->
                android.util.Log.d("Dsh2PhonePerf", phase + " +" + elapsed + "ms " + value));
    }

    private final class NativeBridge {
        @JavascriptInterface
        public void setPageBackground(String color) {
            runOnUiThread(() -> {
                Integer parsed = parseCssColor(color);
                if (parsed != null) applyBarColors(parsed);
            });
        }

        @JavascriptInterface
        public void hideKeyboard() {
            runOnUiThread(() -> {
                if (webView == null) return;
                InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
            });
        }
    }

    public static Intent intent(Context context) {
        // 已存在 WebView 时把它提到前台，不重建 Activity，也不重新加载 DSH。
        return new Intent(context, WebAppActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // AndroidX 官方 edge-to-edge：系统栏透明，内容自己画到状态栏/导航栏后面。
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT),
                SystemBarStyle.dark(Color.TRANSPARENT));
        setContentView(R.layout.activity_web);
        store = new PairStore(this);
        pairing = store.load();
        if (pairing == null) {
            finish();
            return;
        }

        webRoot = findViewById(R.id.webRoot);
        progress = findViewById(R.id.progress);
        banner = findViewById(R.id.banner);
        bannerText = findViewById(R.id.bannerText);
        bannerAction = findViewById(R.id.bannerAction);
        webView = findViewById(R.id.webView);

        applyInsets();
        applyFallbackBars();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });

        fileChooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            if (callback == null) return;
            Uri[] uris = null;
            if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                Intent data = result.getData();
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    uris = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            callback.onReceiveValue(uris);
        });

        configureWebView();
        webView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) userTouchedPage = true;
            return false;
        });
        activeOrigin = pairing.origin;
        injectCookies();
        entryUrl = pairing.entryUrl();
        lanDirectEnabledAtLoad = AppPrefs.lanDirectEnabled(this);
        // 先做一次直连决策再进 /dsh/：电脑端在同一局域网时直连（省掉公网绕行），
        // 否则照旧走公网。二次进入复用 Activity，不重复决策。
        resolveDirectEntry();
    }

    /**
     * 直连决策（后台）：缓存地址快探与 relay 查询并行，命中即用直连 origin 进入。
     * 电脑端不在同一局域网时只有一次公网查询的开销（通常一次 RTT，响应 {"lan":null}）。
     */
    private void resolveDirectEntry() {
        progress.setVisibility(View.VISIBLE);
        if (!lanDirectEnabledAtLoad) {
            // 设置里关闭「局域网直连」：即使同网也强制走公网，用于测试公网链路。
            activeOrigin = pairing.origin;
            entryUrl = pairing.entryUrl();
            injectCookies();
            if (isDebugBuild()) {
                android.util.Log.d("Dsh2PhoneWeb", "lan direct disabled by setting");
            }
            webView.loadUrl(entryUrl);
            return;
        }
        final Pairing current = pairing;
        final String cachedOrigin = store.lanOrigin();
        final String cachedFp = store.lanFp();
        lanExecutor.execute(() -> {
            LanDirect.Direct direct = null;
            Throwable resolveError = null;
            try {
                direct = LanDirect.resolve(current, cachedOrigin, cachedFp, 500, 800, 2500);
            } catch (Throwable t) {
                resolveError = t;
            }
            final LanDirect.Direct result = direct;
            final Throwable capturedError = resolveError;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || webView == null) return;
                if (capturedError != null && isDebugBuild()) {
                    android.util.Log.d("Dsh2PhoneWeb", "lan resolve failed: " + capturedError);
                }
                if (result != null) {
                    directOrigin = result.origin;
                    directFp = result.fp;
                    activeOrigin = result.origin;
                    // 直连边缘的根就是 DSH 根（没有 /dsh/ 前缀），入口固定为 "/"。
                    entryUrl = result.origin + "/";
                    store.saveLanDirect(result.origin, result.fp);
                    injectCookies();
                    if (isDebugBuild()) {
                        android.util.Log.d("Dsh2PhoneWeb", "lan direct enabled: " + result.origin);
                    }
                } else {
                    activeOrigin = pairing.origin;
                    entryUrl = pairing.entryUrl();
                }
                android.util.Log.d("Dsh2PhonePerf", "loadUrl +"
                        + (android.os.SystemClock.elapsedRealtime() - createdAt)
                        + "ms direct=" + (result != null));
                webView.loadUrl(entryUrl);
            });
        });
    }

    /** 直连不可用（断网 / 指纹不匹配）时回退公网中继；每个会话只回退一次。 */
    private void lanFallback() {
        if (directOrigin == null || lanFallback) return;
        lanFallback = true;
        directOrigin = null;
        directFp = null;
        activeOrigin = pairing.origin;
        entryUrl = pairing.entryUrl();
        injectCookies();
        showBanner(R.string.web_lan_fallback, R.string.web_retry, false, () -> webView.loadUrl(entryUrl));
        webView.loadUrl(entryUrl);
    }

    private boolean isDirectUrl(String url) {
        if (directOrigin == null || url == null) return false;
        Uri uri = Uri.parse(url);
        Uri direct = Uri.parse(directOrigin);
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (!uri.getHost().equalsIgnoreCase(direct.getHost())) return false;
        return effectivePort(uri) == effectivePort(direct);
    }

    /** 直连路径 → 公网等价地址（entryPath 就是公网链路的挂载前缀，如 /dsh/）。 */
    private String toPublicUrl(Uri uri) {
        String prefix = "";
        if (pairing.entryPath != null && !pairing.entryPath.equals("/")) {
            prefix = pairing.entryPath.endsWith("/")
                    ? pairing.entryPath.substring(0, pairing.entryPath.length() - 1)
                    : pairing.entryPath;
        }
        String path = uri.getPath() == null ? "/" : uri.getPath();
        String query = uri.getEncodedQuery() == null ? "" : "?" + uri.getEncodedQuery();
        return pairing.origin + prefix + path + query;
    }

    private void applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(webRoot, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // IME 弹出时立即缩 WebView，不等输入内容变化；左右也避开刘海/侧边导航栏。
            v.setPadding(
                    Math.max(bars.left, cut.left),
                    Math.max(bars.top, cut.top),
                    Math.max(bars.right, cut.right),
                    Math.max(bars.bottom, ime.bottom));
            return insets;
        });
        ViewCompat.requestApplyInsets(webRoot);
    }

    private void applyFallbackBars() {
        // 深色兜底：即使页面 bridge 还没返回，也不会出现白底白图标。
        applyBarColors(Color.rgb(10, 20, 32));
    }

    private int lastBarColor = Color.TRANSPARENT;

    private void applyBarColors(int color) {
        // 接近纯黑的颜色在部分 Android/SystemUI 上会被“对比度保护”抬成白色；
        // 深色页面统一用 #333，既保持深色观感，又不会被系统强行变白。
        int bar = ColorUtils.calculateLuminance(color) < 0.05f
                ? Color.rgb(51, 51, 51)
                : color;
        lastBarColor = bar;
        // 官方 edge-to-edge 做法：系统栏保持透明，根布局铺到系统栏下方，
        // 由视图背景提供颜色；不再依赖 setStatusBarColor（API 35 起已弱化）。
        if (webRoot != null) webRoot.setBackgroundColor(bar);
        boolean lightIcons = ColorUtils.calculateLuminance(bar) > 0.5;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(lightIcons);
            controller.setAppearanceLightNavigationBars(lightIcons);
        }
    }

    private static Integer parseCssColor(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length() - 1).trim();
        }
        if (s.isEmpty() || "null".equalsIgnoreCase(s) || "transparent".equalsIgnoreCase(s)) return null;
        if (s.startsWith("#")) {
            try {
                return Color.parseColor(s);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        Matcher m = Pattern.compile(
                "rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?\\s*\\)")
                .matcher(s);
        if (!m.find()) return null;
        int alpha = 255;
        if (m.group(4) != null) {
            alpha = Math.round(Float.parseFloat(m.group(4)) * 255);
        }
        if (alpha == 0) return null;
        int r = Math.min(255, Integer.parseInt(m.group(1)));
        int g = Math.min(255, Integer.parseInt(m.group(2)));
        int b = Math.min(255, Integer.parseInt(m.group(3)));
        return Color.rgb(r, g, b);
    }

    private void injectPageHooks(WebView view) {
        if (view == null) return;
        view.evaluateJavascript(THEME_SEND_JS, null);
    }

    private void scheduleKeyboardSuppression() {
        uiHandler.removeCallbacks(suppressKeyboard);
        uiHandler.postDelayed(suppressKeyboard, 180);
        uiHandler.postDelayed(suppressKeyboard, 800);
        uiHandler.postDelayed(suppressKeyboard, 1600);
    }

    private void doSuppressKeyboard() {
        if (webView == null || userTouchedPage) return;
        webView.clearFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
        webView.evaluateJavascript(
                "(function(){try{var a=document.activeElement;"
                        + "if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable))a.blur();"
                        + "}catch(e){}})()", null);
        webView.evaluateJavascript(FOCUS_GUARD_JS, null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Pairing latest = store.load();
        if (latest == null) {
            finish();
            return;
        }
        pairing = latest;
        boolean wantDirect = AppPrefs.lanDirectEnabled(this);
        if (wantDirect != lanDirectEnabledAtLoad) {
            lanDirectEnabledAtLoad = wantDirect;
            applyLanDirectSetting(wantDirect);
        }
        if (webView != null) {
            webView.onResume();
            injectPageHooks(webView);
            // 某些 SystemUI 在 activity resume 时会重置状态栏，重新按当前页面色上色。
            if (lastBarColor != Color.TRANSPARENT) applyBarColors(lastBarColor);
        }
    }

    /** 设置页切换「局域网直连」后，按新值切到直连或公网（无需杀进程）。 */
    private void applyLanDirectSetting(boolean enabled) {
        if (webView == null || pairing == null) return;
        if (!enabled && directOrigin != null) {
            // 正在直连：立刻切回公网，避免继续复用已建立的直连会话。
            directOrigin = null;
            directFp = null;
            lanFallback = false;
            activeOrigin = pairing.origin;
            entryUrl = pairing.entryUrl();
            injectCookies();
            webView.loadUrl(entryUrl);
        } else if (enabled && directOrigin == null) {
            // 从公网切回自动：重新做一次直连决策，命中则直连，否则仍走公网。
            resolveDirectEntry();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyFallbackBars();
        if (webRoot != null) ViewCompat.requestApplyInsets(webRoot);
        if (webView != null) injectPageHooks(webView);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSafeBrowsingEnabled(true);
        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " " + AppIdentity.userAgent(this));

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        // 只暴露两个无数据能力：状态栏取色、发送后收键盘。页面被限制在已配对 origin。
        webView.addJavascriptInterface(new NativeBridge(), "Dsh2PhoneNative");

        // WebView 默认可能没有把 native View 标记为 long-clickable，导致长按不进入
        // 文本选择 ActionMode；显式打开（不要设置 OnLongClickListener，否则会抢占）。
        webView.setLongClickable(true);
        webView.setHapticFeedbackEnabled(true);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.app_background));
        if (isDebugBuild()) WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(0);
                uiHandler.removeCallbacks(suppressKeyboard);
                if (entryUrl == null || entryUrl.equals(url)) userTouchedPage = false;
                applyFallbackBars();
                logPerf("pageStarted");
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                injectPageHooks(view);
                logPerf("commitVisible");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                injectPageHooks(view);
                scheduleKeyboardSuppression();
                logPerf("pageFinished");
                uiHandler.postDelayed(() -> logPerf("settled"), 3000);
                String title = view.getTitle();
                if (isDebugBuild()) {
                    android.util.Log.d("Dsh2PhoneWeb", "finished " + url + " title=" + title);
                    view.evaluateJavascript("(function(){return typeof window.Dsh2PhoneNative;})()",
                            value -> android.util.Log.d("Dsh2PhoneWeb", "bridge=" + value));
                }
                if (title == null) return;
                if (title.contains("未知设备") || title.contains("设备已被停用")
                        || title.contains("无效的访问方式")) {
                    showBanner(R.string.web_auth_lost, R.string.web_repair, true, WebAppActivity.this::repair);
                } else if (title.contains("电脑端连接中")) {
                    showBanner(R.string.web_offline, R.string.web_retry, false,
                            () -> webView.loadUrl(entryUrl));
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                if (!request.isForMainFrame()) return;
                int status = errorResponse.getStatusCode();
                if (isDebugBuild()) {
                    android.util.Log.d("Dsh2PhoneWeb", "http " + status + " " + request.getUrl());
                }
                // 502 是直连边缘的“DSH 没应答”页，与公网 relay 的 503 同义。
                if (status == 403) {
                    showBanner(R.string.web_auth_lost, R.string.web_repair, true, WebAppActivity.this::repair);
                } else if (status == 503 || status == 502) {
                    showBanner(R.string.web_offline, R.string.web_retry, false,
                            () -> webView.loadUrl(entryUrl));
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                if (isDebugBuild()) {
                    android.util.Log.d("Dsh2PhoneWeb", "error " + request.getUrl()
                            + " code=" + error.getErrorCode() + " desc=" + error.getDescription());
                }
                // 直连会话中途断网（离开家 / Wi-Fi 切换）：静默回落公网，而不是报错。
                if (directOrigin != null && isDirectUrl(request.getUrl().toString())) {
                    lanFallback();
                    return;
                }
                showBanner(R.string.err_network, R.string.web_retry, true,
                        () -> webView.loadUrl(entryUrl));
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Toast.makeText(WebAppActivity.this, R.string.generic_error, Toast.LENGTH_LONG).show();
                finish();
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // 直连边缘用自签证书：只认通过 relay 转介且锁定指纹的那张证书，
                // 指纹不匹配（LAN 内有人冒充 / 电脑端换了证书）立即取消并回落公网。
                if (directFp != null && isDirectUrl(error.getUrl())) {
                    android.net.http.SslCertificate certificate = error.getCertificate();
                    java.security.cert.X509Certificate x509 = certificate == null ? null : certificate.getX509Certificate();
                    if (x509 != null && LanDirect.certMatchesFp(x509, directFp)) {
                        handler.proceed();
                    } else {
                        handler.cancel();
                        lanFallback();
                    }
                    return;
                }
                if (pairing.allowBadCert) {
                    handler.proceed();
                    return;
                }
                if (sslDialogShown) {
                    handler.cancel();
                    return;
                }
                sslDialogShown = true;
                String host = Uri.parse(error.getUrl()).getHost();
                new MaterialAlertDialogBuilder(WebAppActivity.this)
                        .setTitle(R.string.web_ssl_title)
                        .setMessage(getString(R.string.web_ssl_message, host == null ? pairing.origin : host))
                        .setCancelable(false)
                        .setNegativeButton(R.string.web_ssl_cancel, (d, w) -> handler.cancel())
                        .setPositiveButton(R.string.web_ssl_continue, (d, w) -> {
                            pairing = pairing.withAllowBadCert(true);
                            store.setAllowBadCert(true);
                            handler.proceed();
                        })
                        .show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (isDebugBuild()) {
                    android.util.Log.d("Dsh2PhoneWeb", "console " + message.message()
                            + " @" + message.lineNumber());
                }
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress >= 100) {
                    progress.setVisibility(View.GONE);
                } else {
                    progress.setVisibility(View.VISIBLE);
                    progress.setProgress(newProgress);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    fileChooser.launch(Intent.createChooser(intent, getString(R.string.app_name)));
                } catch (Exception e) {
                    fileCallback = null;
                    filePathCallback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          android.os.Message resultMsg) {
                WebView.HitTestResult hit = view.getHitTestResult();
                if (hit != null && hit.getExtra() != null) {
                    Uri uri = Uri.parse(hit.getExtra());
                    if (sameOrigin(uri)) {
                        view.loadUrl(uri.toString());
                        return true;
                    }
                    showExternal(uri);
                    return true;
                }
                return false;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                handleDownload(url, contentDisposition, mimeType));
    }

    private void injectCookies() {
        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        for (Cookie cookie : pairing.cookies) {
            if (cookie.isExpired()) continue;
            manager.setCookie(activeOrigin + "/", cookie.toHeaderValue());
        }
        manager.flush();
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if ("http".equals(scheme) || "https".equals(scheme)) {
            if (sameOrigin(uri)) return false;
            showExternal(uri);
            return true;
        }
        if ("mailto".equals(scheme) || "tel".equals(scheme)) {
            showExternal(uri);
            return true;
        }
        return true;
    }

    private boolean sameOrigin(Uri uri) {
        Uri origin = Uri.parse(activeOrigin);
        if (uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase(origin.getScheme())) return false;
        if (uri.getHost() == null || !uri.getHost().equalsIgnoreCase(origin.getHost())) return false;
        return effectivePort(uri) == effectivePort(origin);
    }

    private int effectivePort(Uri uri) {
        if (uri.getPort() > 0) return uri.getPort();
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        return "https".equals(scheme) ? 443 : ("http".equals(scheme) ? 80 : -1);
    }

    private void showExternal(Uri uri) {
        if (externalDialogShown) return;
        externalDialogShown = true;
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.web_external_title)
                .setMessage(getString(R.string.web_external_message, uri.toString()))
                .setCancelable(true)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.web_external_open, (d, w) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        Toast.makeText(this, R.string.generic_error, Toast.LENGTH_SHORT).show();
                    }
                })
                .setOnDismissListener(d -> externalDialogShown = false)
                .show();
    }

    private void handleDownload(String url, String contentDisposition, String mimeType) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            Toast.makeText(this, R.string.web_download_unsupported, Toast.LENGTH_LONG).show();
            return;
        }
        try {
            Uri source = Uri.parse(url);
            // DownloadManager 无法锁定自签证书：直连同源下载一律改写到公网等价地址。
            boolean direct = isDirectUrl(url);
            String requestUrl = direct ? toPublicUrl(source) : url;
            Uri target = Uri.parse(requestUrl);
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(target);
            request.setTitle(fileName);
            request.setDescription(pairing.origin);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            String cookies = pairing.cookieHeader();
            boolean sameOriginTarget = direct ? sameOrigin(source) : sameOrigin(target);
            if (!cookies.isEmpty() && sameOriginTarget) {
                request.addRequestHeader("Cookie", cookies);
            }
            request.addRequestHeader("User-Agent", AppIdentity.userAgent(this));
            if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                Toast.makeText(this, R.string.web_download_started, Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, R.string.web_download_unsupported, Toast.LENGTH_LONG).show();
        }
    }

    private void showBanner(int messageRes, int actionRes, boolean error, Runnable action) {
        banner.setVisibility(View.VISIBLE);
        bannerText.setText(messageRes);
        bannerAction.setText(actionRes);
        int bg = error ? R.color.error_banner_background : R.color.warning_banner_background;
        int fg = error ? R.color.error_banner_text : R.color.warning_banner_text;
        banner.setCardBackgroundColor(ContextCompat.getColor(this, bg));
        bannerText.setTextColor(ContextCompat.getColor(this, fg));
        bannerAction.setTextColor(ContextCompat.getColor(this, fg));
        bannerAction.setOnClickListener(v -> {
            hideBanner();
            action.run();
        });
    }

    private void hideBanner() {
        banner.setVisibility(View.GONE);
    }

    private void repair() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_SCAN_NOW, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }

    /**
     * 返回键：先让页面自己处理（关掉最上层浮层）→ 再看网页历史 → 最后回 App 主页。
     *
     * DSH 的 Web GUI 不写 URL 历史，所以「后退」实际是「关浮层」；浮层关掉后再按
     * 一次就回主页（主页用 REORDER_TO_FRONT 提到前台，WebView 实例与页面状态都保留）。
     */
    private void handleBack() {
        if (webView == null) {
            finish();
            return;
        }
        // App 自己的错误横幅也是盖在页面上的浮层，先收掉它。
        if (banner != null && banner.getVisibility() == View.VISIBLE) {
            hideBanner();
            return;
        }
        if (backPending) return;
        backPending = true;
        // 页面卡死 / JS 不回调时也要能退出，不让返回键失灵。
        uiHandler.postDelayed(backTimeout, 400);
        webView.evaluateJavascript(BACK_DISMISS_JS, value -> {
            uiHandler.removeCallbacks(backTimeout);
            if (!backPending) return; // 已由超时兜底处理
            backPending = false;
            if ("true".equals(value)) return; // 页面已接管（关掉了浮层）
            backFallback();
        });
    }

    private void backFallback() {
        if (webView == null) {
            finish();
            return;
        }
        if (webView.canGoBack()) {
            // 少数页面（如 PDF 预览）会走真实同文档历史，这时按浏览器语义后退。
            webView.goBack();
            return;
        }
        // 回主页但不 finish：保留 WebView/页面状态，下次进入直接复用。
        startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
    }

    private boolean isDebugBuild() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacks(suppressKeyboard);
        uiHandler.removeCallbacks(backTimeout);
        backPending = false;
        lanExecutor.shutdownNow();
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("Dsh2PhoneNative");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            if (webView.getParent() instanceof android.view.ViewGroup) {
                ((android.view.ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
