#!/usr/bin/env python3
"""
Train the Alpha.fun entry model from the signal log.

  1. Export labelled signals from the dashboard (Reports page, or GET /api/export/signals.csv with your token)
  2. python python/train.py signals.csv --out data/model.json
  3. Set PREDICTOR=model in .env and restart

Honest validation (this is what makes the number worth trusting):
  - chronological split: the model never sees the future of the data it is scored on
  - purge gap: training rows whose label window overlaps the test period are dropped
  - token holdout: tokens seen in training are removed from the test set
  - chronological-only fallback is explicitly weaker and requires --allow-chronological-only
  - the export is REFUSED if out-of-sample AUC < 0.55 or fewer than 500 labelled signals (override: --force)
A model trained on simulated data is stamped source=sim and the engine will refuse to use it on live data.
"""
import argparse
import csv
import json
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, precision_score, recall_score, roc_auc_score

FEATURES = [
    "buy_ratio", "smart_wallets", "social_velocity", "volume_turnover", "log_holders",
    "top10_pct", "log_liquidity", "age_minutes", "price_change_5m",
]
MIN_SAMPLES = 500
MIN_AUC = 0.55


def load(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("The CSV is empty.")
    missing = [c for c in FEATURES + ["tick", "mint", "label", "source"] if c not in rows[0]]
    if missing:
        sys.exit(f"The CSV is missing columns: {missing}")
    sources = {r["source"] for r in rows}
    if len(sources) != 1:
        sys.exit(f"The CSV mixes data sources {sources}. Train on one source at a time.")
    rows = [r for r in rows if r["label"] in ("0", "1")]
    X = np.array([[float(r[c]) for c in FEATURES] for r in rows], dtype=float)
    y = np.array([int(r["label"]) for r in rows])
    tick = np.array([int(r["tick"]) for r in rows])
    mint = np.array([r["mint"] for r in rows])
    order = np.argsort(tick, kind="stable")
    return X[order], y[order], tick[order], mint[order], sources.pop()


def fit_logistic(X, y, C):
    mean = X.mean(axis=0)
    scale = X.std(axis=0)
    scale[scale < 1e-9] = 1.0
    clf = LogisticRegression(C=C, max_iter=2000, class_weight=None)
    clf.fit((X - mean) / scale, y)
    return clf, mean, scale


def predict(clf, mean, scale, X):
    return clf.predict_proba((X - mean) / scale)[:, 1]


def calibration_table(p, y, bins=5):
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    out = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & (p <= hi if i == bins - 1 else p < hi)
        if m.sum():
            out.append({"bucket": i + 1, "n": int(m.sum()), "mean_pred": float(p[m].mean()), "actual_rate": float(y[m].mean())})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="data/model.json")
    ap.add_argument("--horizon", type=int, default=90, help="label horizon in ticks (purge gap)")
    ap.add_argument("--up", type=float, default=40)
    ap.add_argument("--down", type=float, default=20)
    ap.add_argument("--force", action="store_true", help="write the model even if validation fails (not recommended)")
    ap.add_argument("--allow-chronological-only", action="store_true", help="allow export when token holdout is too small; records weaker validation in model metadata")
    a = ap.parse_args()

    X, y, tick, mint, source = load(a.csv)
    n = len(y)
    print(f"{n} labelled signals from '{source}' data, base rate {y.mean():.1%}")
    if y.min() == y.max():
        sys.exit("Only one class in the labels; nothing to learn from.")

    # chronological split: oldest 70% train, newest 30% test
    cut_tick = tick[int(n * 0.7)]
    train = tick < cut_tick - a.horizon  # purge gap
    test = tick >= cut_tick
    test &= ~np.isin(mint, np.unique(mint[train]))  # tokens unseen in training
    token_holdout_samples = int(test.sum())
    validation_mode = "token_holdout"
    if train.sum() < 100 or test.sum() < 50:
        # Keep chronological metrics available, but do not present them as token-generalization evidence.
        test = tick >= cut_tick
        validation_mode = "chronological_only"
        print("WARNING: token holdout left too little data; using weaker chronological-only validation")
    if train.sum() < 100:
        sys.exit(f"Only {int(train.sum())} training rows remain after the purge gap; collect more chronological data.")
    if test.sum() < 50:
        sys.exit(f"Only {int(test.sum())} test rows remain; at least 50 are required for a minimally useful evaluation.")
    print(f"train {int(train.sum())}  test {int(test.sum())}")

    # choose regularisation by walk-forward inside the training part only
    best_c, best_auc = 1.0, -1.0
    tr_idx = np.where(train)[0]
    for C in (0.01, 0.1, 1.0, 10.0):
        aucs = []
        for k in (3, 4, 5):
            split = int(len(tr_idx) * k / 6)
            fit_i, val_i = tr_idx[:max(split - 1, 1)], tr_idx[split:int(len(tr_idx) * (k + 1) / 6)]
            if len(val_i) < 30 or y[fit_i].min() == y[fit_i].max() or y[val_i].min() == y[val_i].max():
                continue
            clf, mean, scale = fit_logistic(X[fit_i], y[fit_i], C)
            aucs.append(roc_auc_score(y[val_i], predict(clf, mean, scale, X[val_i])))
        if aucs and np.mean(aucs) > best_auc:
            best_auc, best_c = float(np.mean(aucs)), C
    print(f"regularisation C={best_c} (walk-forward AUC {best_auc:.3f})")

    clf, mean, scale = fit_logistic(X[train], y[train], best_c)
    p_test = predict(clf, mean, scale, X[test])
    auc = float(roc_auc_score(y[test], p_test)) if y[test].min() != y[test].max() else float("nan")
    brier = float(brier_score_loss(y[test], p_test))
    pr_auc = float(average_precision_score(y[test], p_test))
    threshold = 0.5
    precision = float(precision_score(y[test], p_test >= threshold, zero_division=0))
    recall = float(recall_score(y[test], p_test >= threshold, zero_division=0))
    base_brier = float(brier_score_loss(y[test], np.full(test.sum(), y[train].mean())))
    top = p_test >= np.quantile(p_test, 0.8)
    lift = float(y[test][top].mean() / max(y[test].mean(), 1e-9))

    gbm = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, random_state=0).fit(X[train], y[train])
    gbm_auc = float(roc_auc_score(y[test], gbm.predict_proba(X[test])[:, 1]))

    print(f"\nOut-of-sample AUC        {auc:.3f}   (0.5 = coin flip)")
    print(f"PR-AUC                   {pr_auc:.3f}   (useful for imbalanced labels)")
    print(f"Precision / recall @0.5  {precision:.3f} / {recall:.3f}")
    print(f"Brier score              {brier:.4f}  (baseline {base_brier:.4f}, lower is better)")
    print(f"Top-20% hit rate lift    {lift:.2f}x vs average")
    print(f"Gradient boosting AUC    {gbm_auc:.3f}  (comparison only, not exported)")
    cal = calibration_table(p_test, y[test])
    print("Calibration (predicted vs actual):")
    for c in cal:
        print(f"  bucket {c['bucket']}: n={c['n']:4d}  predicted {c['mean_pred']:.2f}  actual {c['actual_rate']:.2f}")

    problems = []
    if validation_mode == "chronological_only" and not a.allow_chronological_only:
        problems.append(f"token holdout validation unavailable ({token_holdout_samples} held-out samples); chronological-only evidence is weaker (use --allow-chronological-only to explicitly accept)")
    if n < MIN_SAMPLES:
        problems.append(f"only {n} labelled signals (need {MIN_SAMPLES}+)")
    if not auc >= MIN_AUC:
        problems.append(f"out-of-sample AUC {auc:.3f} is below {MIN_AUC}")
    if source == "sim":
        print("\nNote: this is SIMULATED data. The model is stamped source=sim and cannot be used on the live feed.")
    if problems and not a.force:
        print("\nNOT exporting the model: " + "; ".join(problems) + ". Collect more data or use --force to override.")
        sys.exit(2)
    if problems:
        print("\nWARNING (forced export): " + "; ".join(problems))

    # final model uses all data, with the regularisation chosen above
    clf_f, mean_f, scale_f = fit_logistic(X, y, best_c)
    rng = np.random.default_rng(0)
    idx = rng.choice(n, size=min(25, n), replace=False)
    probs = predict(clf_f, mean_f, scale_f, X[idx])
    model = {
        "schema": 1,
        "feature_names": FEATURES,
        "mean": mean_f.tolist(),
        "scale": scale_f.tolist(),
        "coef": clf_f.coef_[0].tolist(),
        "intercept": float(clf_f.intercept_[0]),
        "source": source,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_train": int(n),
        "label": {"up_pct": a.up, "down_pct": a.down, "horizon_ticks": a.horizon},
        "metrics": {"oos_auc": auc, "pr_auc": pr_auc, "precision_at_0_5": precision, "recall_at_0_5": recall, "brier": brier, "baseline_brier": base_brier, "top20_lift": lift, "gbm_auc": gbm_auc, "C": best_c, "calibration": cal, "forced": bool(problems), "validation_mode": validation_mode, "token_holdout_samples": token_holdout_samples, "token_holdout_passed": validation_mode == "token_holdout"},
        "samples": [{"features": dict(zip(FEATURES, map(float, X[i]))), "prob": float(p)} for i, p in zip(idx, probs)],
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2)
    print(f"\nWrote {a.out}")


if __name__ == "__main__":
    main()
