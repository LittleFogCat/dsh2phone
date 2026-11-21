package tech.xiaoniu.dsh2phone;

import android.content.Context;

/** 把网络层的结果翻译成用户能照着做的提示。 */
public final class PairingErrors {
    private PairingErrors() {
    }

    public static String message(Context context, PairingClient.Result result) {
        switch (result.status) {
            case CODE_EXPIRED:
                return context.getString(R.string.err_code_expired);
            case REJECTED:
                return detailOr(result.serverDetail, context.getString(R.string.err_rejected));
            case TUNNEL_OFFLINE:
                return context.getString(R.string.err_tunnel_offline);
            case NO_CREDENTIAL:
                return context.getString(R.string.err_no_credential);
            case CERT_ERROR:
                return context.getString(R.string.err_cert);
            case DNS_ERROR:
                return context.getString(R.string.err_dns);
            case CONNECT_ERROR:
                return context.getString(R.string.err_connect);
            case TIMEOUT:
                return context.getString(R.string.err_timeout);
            case NETWORK_ERROR:
                return context.getString(R.string.err_network);
            case UNEXPECTED:
                return context.getString(R.string.err_unexpected);
            case CANCELLED:
                return context.getString(R.string.pair_cancelled);
            case HTTP_ERROR:
                String base = context.getString(R.string.err_http_status, result.httpStatus);
                return detailOr(result.serverDetail, base);
            case SUCCESS:
            default:
                return "";
        }
    }

    private static String detailOr(String detail, String fallback) {
        return detail == null || detail.trim().isEmpty() ? fallback : detail.trim();
    }
}
