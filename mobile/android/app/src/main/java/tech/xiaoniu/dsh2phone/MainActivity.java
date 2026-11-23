package tech.xiaoniu.dsh2phone;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends AppCompatActivity {
    public static final String EXTRA_SCAN_NOW = "tech.xiaoniu.dsh2phone.extra.SCAN_NOW";

    private PairStore store;
    private Pairing pairing;

    private MaterialCardView pairedCard;
    private View statusDot;
    private TextView statusText;
    private TextView pairedHost;
    private TextView pairedMeta;
    private TextView homeTitle;
    private TextView homeSubtitle;
    private TextView pairedBadge;
    private MaterialButton scanButton;
    private View manualButton;
    private View stepsCard;

    private final ExecutorService probeExecutor = Executors.newSingleThreadExecutor();
    private boolean probeRunning;

    private ActivityResultLauncher<ScanOptions> scanner;
    private ActivityResultLauncher<String> cameraPermission;
    private ActivityResultLauncher<Intent> pairLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        Bars.apply(this, findViewById(R.id.root));
        store = new PairStore(this);

        MaterialToolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);

        pairedCard = findViewById(R.id.pairedCard);
        statusDot = findViewById(R.id.statusDot);
        statusText = findViewById(R.id.statusText);
        pairedHost = findViewById(R.id.pairedHost);
        pairedMeta = findViewById(R.id.pairedMeta);
        homeTitle = findViewById(R.id.homeTitle);
        homeSubtitle = findViewById(R.id.homeSubtitle);
        pairedBadge = findViewById(R.id.pairedBadge);
        scanButton = findViewById(R.id.scanButton);
        manualButton = findViewById(R.id.manualButton);
        stepsCard = findViewById(R.id.stepsCard);

        scanner = registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null && !result.getContents().isEmpty()) {
                confirmPair(result.getContents());
            }
        });
        cameraPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) launchScanner();
            else showCameraPermissionDialog();
        });
        pairLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (result.getResultCode() == PairActivity.RESULT_RESCAN) startScanFlow();
        });

        scanButton.setOnClickListener(v -> startScanFlow());
        findViewById(R.id.manualButton).setOnClickListener(v -> showManualLinkDialog());
        findViewById(R.id.enterButton).setOnClickListener(v -> openDsh());
        findViewById(R.id.repairButton).setOnClickListener(v -> startScanFlow());
        findViewById(R.id.unpairButton).setOnClickListener(v -> confirmUnpair());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // 主页是任务根；WebApp 可能还在任务栈里，不能让它重新露出来。
                // 走 dispatcher 而不是已废弃的 onBackPressed()：targetSdk 35 起
                // 预测性返回默认开启，废弃回调可能收不到返回键。
                finishAffinity();
            }
        });

        handleIntent(getIntent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        pairing = store.load();
        render();
        if (pairing != null) {
            probe();
            UpdateManager.check(this, pairing, false);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onDestroy() {
        probeExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.menu_main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_settings) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        if (id == R.id.action_about) {
            showAbout();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra(EXTRA_SCAN_NOW, false)) {
            intent.removeExtra(EXTRA_SCAN_NOW);
            startScanFlow();
            return;
        }
        Uri data = intent.getData();
        if (data != null && "dsh2phone".equals(data.getScheme()) && "pair".equals(data.getHost())) {
            String url = data.getQueryParameter("url");
            intent.setData(null);
            if (url == null || url.trim().isEmpty()) {
                Toast.makeText(this, R.string.deep_link_invalid, Toast.LENGTH_LONG).show();
                return;
            }
            confirmPair(url);
        }
    }

    private void render() {
        if (pairing == null) {
            pairedCard.setVisibility(View.GONE);
            pairedBadge.setVisibility(View.GONE);
            scanButton.setVisibility(View.VISIBLE);
            manualButton.setVisibility(View.VISIBLE);
            stepsCard.setVisibility(View.VISIBLE);
            homeTitle.setText(R.string.home_title);
            homeSubtitle.setText(R.string.home_subtitle);
            scanButton.setText(R.string.scan_button);
            return;
        }
        pairedCard.setVisibility(View.VISIBLE);
        pairedBadge.setVisibility(View.VISIBLE);
        // 已配对时主操作是“进入 DSH”，重新配对放进卡片里的文字操作，避免两个主按钮打架。
        scanButton.setVisibility(View.GONE);
        manualButton.setVisibility(View.GONE);
        stepsCard.setVisibility(View.GONE);
        homeTitle.setText(R.string.home_paired_title);
        homeSubtitle.setText(R.string.home_paired_subtitle);
        scanButton.setText(R.string.rescan_button);
        pairedHost.setText(pairing.origin);
        String device = getString(R.string.paired_device_format, pairing.deviceName);
        String at = getString(R.string.paired_at_format, formatDate(pairing.pairedAt));
        pairedMeta.setText(device + "\n" + at);
        setStatus(PairProbe.State.UNKNOWN);
        statusText.setText(R.string.status_checking);
    }

    private void startScanFlow() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            launchScanner();
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA);
        }
    }

    private void launchScanner() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt(getString(R.string.scan_prompt));
        options.setBeepEnabled(false);
        // 全端竖屏：扫码页跟着竖屏锁，不随手机转动；否则主界面竖屏、扫码页横屏。
        options.setOrientationLocked(true);
        options.setBarcodeImageEnabled(false);
        scanner.launch(options);
    }

    private void showCameraPermissionDialog() {
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.camera_permission_title)
                .setMessage(R.string.camera_permission_body)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.camera_permission_settings, (d, w) -> {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                })
                .show();
    }

    private void showManualLinkDialog() {
        View view = LayoutInflater.from(this).inflate(R.layout.dialog_manual_link, null, false);
        TextInputLayout inputLayout = view.findViewById(R.id.linkInputLayout);
        TextInputEditText input = view.findViewById(R.id.linkInput);
        TextView error = view.findViewById(R.id.linkError);
        MaterialButton paste = view.findViewById(R.id.pasteButton);

        paste.setOnClickListener(v -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).coerceToText(this);
                if (text != null) input.setText(text.toString().trim());
            }
        });

        androidx.appcompat.app.AlertDialog dialog = new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.manual_title)
                .setView(view)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.confirm_start, null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String raw = input.getText() == null ? "" : input.getText().toString().trim();
                    if (raw.isEmpty()) {
                        inputLayout.setError(getString(R.string.manual_empty));
                        error.setVisibility(View.GONE);
                        return;
                    }
                    inputLayout.setError(null);
                    error.setVisibility(View.GONE);
                    dialog.dismiss();
                    confirmPair(raw);
                }));
        dialog.show();
    }

    private void confirmPair(String raw) {
        PairUrl target;
        try {
            target = PairUrl.parse(raw, isDebugBuild());
        } catch (PairUrl.Invalid invalid) {
            new MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.pair_failed)
                    .setMessage(messageFor(invalid.error))
                    .setPositiveButton(R.string.action_close, null)
                    .show();
            return;
        }

        String host = PairUrl.displayHost(target.host, target.port);
        if (pairing != null && !pairing.origin.equals(target.origin)) {
            new MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.confirm_replace_title)
                    .setMessage(getString(R.string.confirm_replace_body, pairing.origin))
                    .setNegativeButton(R.string.action_cancel, null)
                    .setPositiveButton(R.string.confirm_start, (d, w) -> showPairConfirm(target, host))
                    .show();
            return;
        }
        showPairConfirm(target, host);
    }

    private void showPairConfirm(PairUrl target, String host) {
        String message = getString(R.string.confirm_body);
        if (target.isInsecure()) {
            message += "\n\n" + getString(R.string.confirm_http_warning);
        }
        new MaterialAlertDialogBuilder(this)
                .setTitle(getString(R.string.confirm_title, host))
                .setMessage(message)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.confirm_start, (d, w) -> {
                    Intent intent = PairActivity.intent(this, target.url);
                    pairLauncher.launch(intent);
                })
                .show();
    }

    private void openDsh() {
        Pairing current = store.load();
        if (current == null) {
            pairing = null;
            render();
            return;
        }
        startActivity(WebAppActivity.intent(this));
    }

    private void confirmUnpair() {
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.settings_unpair_title)
                .setMessage(R.string.settings_unpair_body)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.settings_unpair_confirm, (d, w) -> {
                    store.clear();
                    new StaticCache(MainActivity.this).clear();
                    android.webkit.CookieManager.getInstance().removeAllCookies(null);
                    android.webkit.CookieManager.getInstance().flush();
                    pairing = null;
                    render();
                })
                .show();
    }

    private void showAbout() {
        String version = "1.0.0";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            // 忽略。
        }
        String body = getString(R.string.about_body) + "\n\n" + getString(R.string.settings_version_label)
                + " " + version + " · " + buildType();
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.about_title)
                .setMessage(body)
                .setPositiveButton(R.string.about_ok, null)
                .show();
    }

    private void probe() {
        if (probeRunning) return;
        final Pairing current = pairing;
        if (current == null) return;
        probeRunning = true;
        probeExecutor.execute(() -> {
            PairProbe.State state = PairProbe.check(current, 6000);
            // 在线时顺带探测局域网直连（结果写入缓存，进入 DSH 时可秒命中）。
            LanDirect.Direct direct = null;
            if (state == PairProbe.State.ONLINE && AppPrefs.lanDirectEnabled(MainActivity.this)) {
                try {
                    direct = LanDirect.resolve(current, store.lanOrigin(), store.lanFp(), 500, 800, 2500);
                    if (direct != null) store.saveLanDirect(direct.origin, direct.fp);
                } catch (Throwable ignored) {
                    // 状态展示失败不影响主流程。
                }
            }
            final LanDirect.Direct finalDirect = direct;
            runOnUiThread(() -> {
                probeRunning = false;
                if (isFinishing() || isDestroyed()) return;
                Pairing latest = store.load();
                if (latest == null || !latest.origin.equals(current.origin)) return;
                setStatus(state);
                if (finalDirect != null) {
                    statusText.setText(getString(R.string.status_online_direct));
                }
            });
        });
    }

    private void setStatus(PairProbe.State state) {
        int color;
        int text;
        switch (state) {
            case ONLINE:
                color = ContextCompat.getColor(this, R.color.status_online);
                text = R.string.status_online;
                break;
            case OFFLINE:
                color = ContextCompat.getColor(this, R.color.status_offline);
                text = R.string.status_offline;
                break;
            case UNAUTHORIZED:
                color = ContextCompat.getColor(this, R.color.status_offline);
                text = R.string.status_unauthorized;
                break;
            case UNKNOWN:
            default:
                color = ContextCompat.getColor(this, R.color.status_unknown);
                text = R.string.status_unknown;
                break;
        }
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(color);
        statusDot.setBackground(dot);
        statusText.setText(text);
        statusText.setTextColor(color);
    }

    private String messageFor(PairUrl.Error error) {
        switch (error) {
            case HTTPS_REQUIRED:
                return getString(R.string.err_https_required);
            case BAD_PATH:
                return getString(R.string.err_path);
            case MISSING_CODE:
            case BAD_CODE:
                return getString(R.string.err_code_missing);
            case BAD_HOST:
            case BAD_SCHEME:
            case USERINFO:
            case MALFORMED:
            case EMPTY:
            default:
                return getString(R.string.err_invalid_url);
        }
    }

    private boolean isDebugBuild() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private String buildType() {
        return isDebugBuild() ? getString(R.string.settings_build_debug)
                : getString(R.string.settings_build_release);
    }

    private String formatDate(long timestamp) {
        if (timestamp <= 0) return "—";
        return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(new Date(timestamp));
    }
}
