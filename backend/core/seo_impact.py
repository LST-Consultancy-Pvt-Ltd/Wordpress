def estimate_seo_impact(change_type: str, current_value: str = "", proposed_value: str = "") -> dict:
    """Returns estimated SEO impact for a given change type."""
    impact_map = {
        "meta_title": {
            "traffic_change": "+10-20%",
            "ranking_impact": "Improve by 1-3 positions",
            "ctr_change": "+0.5-1.5%",
            "confidence": "high",
        },
        "meta_description": {
            "traffic_change": "+5-15%",
            "ranking_impact": "Improve CTR without direct rank change",
            "ctr_change": "+0.3-1.2%",
            "confidence": "high",
        },
        "content_refresh": {
            "traffic_change": "+15-30%",
            "ranking_impact": "Improve by 2-5 positions",
            "ctr_change": "+0.5-1.0%",
            "confidence": "medium",
        },
        "internal_link": {
            "traffic_change": "+5-10%",
            "ranking_impact": "Improve by 1-2 positions",
            "ctr_change": "+0.2-0.5%",
            "confidence": "medium",
        },
        "alt_text": {
            "traffic_change": "+2-8%",
            "ranking_impact": "Improve image search visibility",
            "ctr_change": "+0.1-0.3%",
            "confidence": "medium",
        },
        "canonical_fix": {
            "traffic_change": "+5-20%",
            "ranking_impact": "Fix duplicate content penalty",
            "ctr_change": "+0.2-0.8%",
            "confidence": "high",
        },
        "schema_markup": {
            "traffic_change": "+15-35%",
            "ranking_impact": "Enable rich snippets (+3-8% CTR boost)",
            "ctr_change": "+1.0-3.5%",
            "confidence": "high",
        },
        "self_heal": {
            "traffic_change": "+8-18%",
            "ranking_impact": "Fix multiple on-page issues",
            "ctr_change": "+0.4-1.2%",
            "confidence": "medium",
        },
    }
    return impact_map.get(change_type, {
        "traffic_change": "+5-15%",
        "ranking_impact": "Moderate improvement expected",
        "ctr_change": "+0.2-0.8%",
        "confidence": "low",
    })
