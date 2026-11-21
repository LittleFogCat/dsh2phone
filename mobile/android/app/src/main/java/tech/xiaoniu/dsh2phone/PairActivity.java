package tech.xiaoniu.dsh2phone;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 配对等待页：网络请求在后台线程，取消时直接断开连接，避免 relay 端一直挂着。 */
public final class PairActivity extends AppCompatActivity {
    public static final int RESULT_RESCAN = RESULT_FIRST_USER;
    private static final String EXTRA_PAIR_URL = "tech.xiaoniu.dsh2phone.extra.PAIR_URL";

    private ProgressBar progress;
    private ImageView stateIcon;
    private TextView stateTitle;
    private TextView stateMessage;
    private TextView stateHint;
    private TextView insecureWarning;
    private MaterialButton primaryButton;
    private MaterialButton secondaryButton;
    private MaterialButton tertiaryButton;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PairingClient client;
    private ExecutorService executor;
    private PairStore store;
    private PairUrl target;
    private String existingDevice;
    private boolean allowBadCert;
    private boolean inFlight;
    private Runnable waitingRunnable;

    public static Intent intent(Context context, String pairUrl) {
        return new Intent(context, PairActivity.class).putExtra(EXTRA_PAIR_URL, pairUrl);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_pair);
        Bars.apply(this, findViewById(R.id.root));
        store = new PairStore(this);

        MaterialToolbar toolbar = findViewById(R.id.toolbar);
        toolbar.setNavigationOnClickListener(v -> cancelAndFinish());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                cancelAndFinish();
            }
        });

        progress = findViewById(R.id.progress);
        stateIcon = findViewById(R.id.stateIcon);
        stateTitle = findViewById(R.id.stateTitle);
        stateMessage = findViewById(R.id.stateMessage);
        stateHint = findViewById(R.id.stateHint);
        insecureWarning = findViewById(R.id.insecureWarning);
        primaryButton = findViewById(R.id.primaryButton);
        secondaryButton = findViewById(R.id.secondaryButton);
        tertiaryButton = findViewById(R.id.tertiaryButton);

        String raw = getIntent().getStringExtra(EXTRA_PAIR_URL);
        try {
            target = PairUrl.parse(raw, isDebugBuild());
        } catch (PairUrl.Invalid invalid) {
            showFatal(getString(R.string.pair_failed), messageFor(invalid.error));
            return;
        }

        Pairing existing = store.load();
        if (existing != null && existing.origin.equals(target.origin)) {
            existingDevice = existing.dshDevValue();
            allowBadCert = existing.allowBadCert;
        }
        insecureWarning.setVisibility(target.isInsecure() ? View.VISIBLE : View.GONE);
        startPairing();
    }

    private void startPairing() {
        if (target == null) return;
        cleanupWorker();
        inFlight = true;
        showConnecting();
        final String ua = AppIdentity.userAgent(this);
        client = new PairingClient(ua);
        executor = Executors.newSingleThreadExecutor();
        final String dev = existingDevice;
        final boolean allow = allowBadCert;

        waitingRunnable = () -> {
            if (!inFlight) return;
            stateTitle.setText(R.string.pair_waiting);
            stateMessage.setText(R.string.pair_waiting_hint);
        };
        handler.postDelayed(waitingRunnable, 1200);

        executor.execute(() -> {
            PairingClient.Result result = client.pair(target, dev, allow);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                onResult(result);
            });
        });
    }

    private void onResult(PairingClient.Result result) {
        inFlight = false;
        handler.removeCallbacks(waitingRunnable);
        if (isDebugBuild()) {
            android.util.Log.d("Dsh2PhonePair", "result " + result.status + " http=" + result.httpStatus
                    + " title=" + result.serverTitle + " detail=" + result.serverDetail);
        }
        if (result.status == PairingClient.Status.CANCELLED) {
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        if (result.isSuccess()) {
            Pairing pairing = new Pairing(target.origin, target.pairPath, result.entryPath,
                    result.deviceName, System.currentTimeMillis(), result.cookies, allowBadCert);
            if (!store.save(pairing)) {
                showFatal(getString(R.string.pair_failed), getString(R.string.generic_error));
                return;
            }
            // 这里不要异步清 WebView cookie：removeAllCookies 的回调可能在新 cookie
            // 注入之后才执行，把刚注入的凭证又抹掉。WebAppActivity 会按 origin 覆盖注入。
            setResult(RESULT_OK);
            showSuccess(result.deviceName);
            return;
        }
        if (result.status == PairingClient.Status.CERT_ERROR && !allowBadCert) {
            showCertError(result);
            return;
        }
        showFailure(result);
    }

    private void showConnecting() {
        progress.setVisibility(View.VISIBLE);
        stateIcon.setVisibility(View.GONE);
        stateTitle.setText(R.string.pair_connecting);
        stateMessage.setText(getString(R.string.pair_connecting_hint,
                PairUrl.displayHost(target.host, target.port)));
        stateHint.setVisibility(View.GONE);
        configureButtons(R.string.action_cancel, v -> cancelAndFinish(), 0, null, 0, null);
    }

    private void showSuccess(String deviceName) {
        progress.setVisibility(View.GONE);
        stateIcon.setVisibility(View.VISIBLE);
        stateIcon.setImageResource(R.drawable.ic_check_circle);
        stateTitle.setText(R.string.pair_success);
        stateMessage.setText(getString(R.string.pair_success_message,
                deviceName == null || deviceName.isEmpty() ? getString(R.string.app_name) : deviceName));
        stateHint.setVisibility(View.VISIBLE);
        stateHint.setText(R.string.pair_success_hint);
        insecureWarning.setVisibility(View.GONE);
        configureButtons(R.string.enter_dsh, v -> openDsh(), R.string.action_done, v -> finish(), 0, null);
    }

    private void showFailure(PairingClient.Result result) {
        progress.setVisibility(View.GONE);
        stateIcon.setVisibility(View.VISIBLE);
        stateIcon.setImageResource(R.drawable.ic_error);
        stateTitle.setText(R.string.pair_failed);
        stateMessage.setText(PairingErrors.message(this, result));
        stateHint.setVisibility(View.GONE);

        boolean rescanFirst = result.status == PairingClient.Status.CODE_EXPIRED
                || result.status == PairingClient.Status.REJECTED
                || result.status == PairingClient.Status.NO_CREDENTIAL;
        if (rescanFirst) {
            configureButtons(R.string.action_rescan, v -> rescan(), R.string.action_cancel, v -> finish(), 0, null);
        } else {
            configureButtons(R.string.action_retry, v -> startPairing(),
                    R.string.action_rescan, v -> rescan(), R.string.action_cancel, v -> finish());
        }
    }

    private void showCertError(PairingClient.Result result) {
        progress.setVisibility(View.GONE);
        stateIcon.setVisibility(View.VISIBLE);
        stateIcon.setImageResource(R.drawable.ic_error);
        stateTitle.setText(R.string.pair_failed);
        stateMessage.setText(PairingErrors.message(this, result));
        stateHint.setVisibility(View.GONE);
        configureButtons(R.string.action_allow_retry, v -> confirmAllowBadCert(),
                R.string.action_rescan, v -> rescan(), R.string.action_cancel, v -> finish());
    }

    private void showFatal(String title, String message) {
        if (progress != null) progress.setVisibility(View.GONE);
        if (stateIcon != null) {
            stateIcon.setVisibility(View.VISIBLE);
            stateIcon.setImageResource(R.drawable.ic_error);
        }
        if (stateTitle != null) stateTitle.setText(title);
        if (stateMessage != null) stateMessage.setText(message);
        if (stateHint != null) stateHint.setVisibility(View.GONE);
        configureButtons(R.string.action_close, v -> finish(), 0, null, 0, null);
    }

    private void configureButtons(int primaryText, View.OnClickListener primaryAction,
                                  int secondaryText, View.OnClickListener secondaryAction,
                                  int tertiaryText, View.OnClickListener tertiaryAction) {
        primaryButton.setText(primaryText);
        primaryButton.setOnClickListener(primaryAction);
        if (secondaryText == 0) {
            secondaryButton.setVisibility(View.GONE);
        } else {
            secondaryButton.setVisibility(View.VISIBLE);
            secondaryButton.setText(secondaryText);
            secondaryButton.setOnClickListener(secondaryAction);
        }
        if (tertiaryText == 0) {
            tertiaryButton.setVisibility(View.GONE);
        } else {
            tertiaryButton.setVisibility(View.VISIBLE);
            tertiaryButton.setText(tertiaryText);
            tertiaryButton.setOnClickListener(tertiaryAction);
        }
    }

    private void confirmAllowBadCert() {
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.settings_allow_bad_cert_warning_title)
                .setMessage(getString(R.string.settings_allow_bad_cert_warning_body,
                        PairUrl.displayHost(target.host, target.port)))
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.settings_allow_bad_cert_confirm, (d, w) -> {
                    allowBadCert = true;
                    store.setAllowBadCert(true);
                    startPairing();
                })
                .show();
    }

    private void openDsh() {
        startActivity(WebAppActivity.intent(this));
        finish();
    }

    private void rescan() {
        setResult(RESULT_RESCAN);
        finish();
    }

    private void cancelAndFinish() {
        if (inFlight) {
            inFlight = false;
            if (client != null) client.cancel();
        }
        cleanupWorker();
        setResult(RESULT_CANCELED);
        finish();
    }

    private void cleanupWorker() {
        if (waitingRunnable != null) handler.removeCallbacks(waitingRunnable);
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    @Override
    protected void onDestroy() {
        cleanupWorker();
        if (client != null) client.cancel();
        super.onDestroy();
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
}
