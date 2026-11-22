package tech.xiaoniu.dsh2phone;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;

public final class SettingsActivity extends AppCompatActivity {
    private PairStore store;
    private Pairing pairing;
    private MaterialSwitch allowBadCertSwitch;
    private MaterialSwitch lanDirectSwitch;
    private TextView host;
    private TextView device;
    private boolean updatingSwitch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        Bars.apply(this, findViewById(R.id.root));
        store = new PairStore(this);
        pairing = store.load();

        MaterialToolbar toolbar = findViewById(R.id.toolbar);
        toolbar.setNavigationOnClickListener(v -> finish());

        host = findViewById(R.id.settingsHost);
        device = findViewById(R.id.settingsDevice);
        allowBadCertSwitch = findViewById(R.id.allowBadCertSwitch);
        lanDirectSwitch = findViewById(R.id.lanDirectSwitch);
        TextView version = findViewById(R.id.settingsVersion);
        TextView build = findViewById(R.id.settingsBuild);
        TextView ua = findViewById(R.id.settingsUa);
        TextView origin = findViewById(R.id.settingsOrigin);

        version.setText(getString(R.string.settings_version_label) + " " + versionName());
        build.setText(getString(R.string.settings_build_label) + " "
                + (isDebugBuild() ? getString(R.string.settings_build_debug) : getString(R.string.settings_build_release)));
        ua.setText(AppIdentity.userAgent(this));

        if (pairing == null) {
            host.setText(R.string.settings_no_pairing);
            device.setText("");
            origin.setText("—");
            allowBadCertSwitch.setEnabled(false);
            allowBadCertSwitch.setAlpha(0.45f);
            View repair = findViewById(R.id.settingsRepair);
            View unpair = findViewById(R.id.settingsUnpair);
            repair.setEnabled(false);
            repair.setAlpha(0.45f);
            unpair.setEnabled(false);
            unpair.setAlpha(0.45f);
        } else {
            host.setText(pairing.origin);
            device.setText(getString(R.string.paired_device_format, pairing.deviceName) + "\n"
                    + getString(R.string.paired_at_format,
                    android.text.format.DateFormat.format("yyyy-MM-dd HH:mm", pairing.pairedAt)));
            origin.setText(pairing.origin);
            updatingSwitch = true;
            allowBadCertSwitch.setChecked(pairing.allowBadCert);
            updatingSwitch = false;
            allowBadCertSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
                if (updatingSwitch) return;
                if (isChecked) confirmAllowBadCert();
                else store.setAllowBadCert(false);
            });
        }

        lanDirectSwitch.setChecked(AppPrefs.lanDirectEnabled(this));
        lanDirectSwitch.setEnabled(pairing != null);
        lanDirectSwitch.setAlpha(pairing == null ? 0.45f : 1f);
        lanDirectSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            AppPrefs.setLanDirectEnabled(this, isChecked);
            if (pairing != null) {
                Toast.makeText(this, R.string.settings_lan_direct_changed, Toast.LENGTH_SHORT).show();
            }
        });

        findViewById(R.id.settingsRepair).setOnClickListener(v -> {
            Intent intent = new Intent(this, MainActivity.class);
            intent.putExtra(MainActivity.EXTRA_SCAN_NOW, true);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
            finish();
        });
        findViewById(R.id.settingsUnpair).setOnClickListener(v -> confirmUnpair());
        findViewById(R.id.copyDiagnostics).setOnClickListener(v -> copyDiagnostics());
        findViewById(R.id.checkUpdates).setOnClickListener(v ->
                UpdateManager.check(this, store.load(), true));
    }

    private void confirmAllowBadCert() {
        if (pairing == null) {
            setSwitch(false);
            return;
        }
        String hostLabel = pairing.origin;
        try {
            Uri parsed = Uri.parse(pairing.origin);
            if (parsed.getAuthority() != null) hostLabel = parsed.getAuthority();
        } catch (Exception ignored) {
            // 保持 origin 原文。
        }
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.settings_allow_bad_cert_warning_title)
                .setMessage(getString(R.string.settings_allow_bad_cert_warning_body, hostLabel))
                .setCancelable(false)
                .setNegativeButton(R.string.action_cancel, (d, w) -> setSwitch(false))
                .setPositiveButton(R.string.settings_allow_bad_cert_confirm, (d, w) -> {
                    if (!store.setAllowBadCert(true)) {
                        Toast.makeText(this, R.string.generic_error, Toast.LENGTH_SHORT).show();
                        setSwitch(false);
                    } else {
                        pairing = pairing.withAllowBadCert(true);
                    }
                })
                .show();
    }

    private void setSwitch(boolean checked) {
        updatingSwitch = true;
        allowBadCertSwitch.setChecked(checked);
        updatingSwitch = false;
    }

    private void confirmUnpair() {
        new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.settings_unpair_title)
                .setMessage(R.string.settings_unpair_body)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.settings_unpair_confirm, (d, w) -> {
                    store.clear();
                    android.webkit.CookieManager.getInstance().removeAllCookies(null);
                    android.webkit.CookieManager.getInstance().flush();
                    setResult(RESULT_OK);
                    finish();
                })
                .show();
    }

    private void copyDiagnostics() {
        String text = "app=" + getPackageName()
                + "\nversion=" + versionName()
                + "\nbuild=" + (isDebugBuild() ? "debug" : "release")
                + "\nua=" + AppIdentity.userAgent(this)
                + "\norigin=" + (pairing == null ? "—" : pairing.origin)
                + "\ndevice=" + (pairing == null ? "—" : pairing.deviceName);
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("dsh2phone diagnostics", text));
            Toast.makeText(this, R.string.settings_copied, Toast.LENGTH_SHORT).show();
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    private boolean isDebugBuild() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
