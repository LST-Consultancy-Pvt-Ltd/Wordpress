<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_WooCommerce — Extended WooCommerce endpoints.
 *
 * Only registered when WooCommerce is active.
 * The WP Manager backend uses WC REST API (/wc/v3/) for main CRUD,
 * these endpoints supplement with AI features, low-stock alerts, etc.
 */
class WPMB_WooCommerce {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        // Get products via WC data store (quick list)
        register_rest_route( $ns, '/woo/products', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_products' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/orders', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_orders' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/customers', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_customers' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/stats', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_stats' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/products/(?P<prod_id>\d+)/ai-description', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'ai_description' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/bulk-ai-descriptions', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'bulk_ai_descriptions' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/woo/low-stock-alert', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'low_stock_alert' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_products(): WP_REST_Response {
        $query = new WC_Product_Query( [
            'limit'  => 100,
            'status' => 'publish',
            'return' => 'objects',
        ] );

        $products = $query->get_products();
        $result   = array_map( function( $p ) {
            return [
                'id'           => $p->get_id(),
                'name'         => $p->get_name(),
                'sku'          => $p->get_sku(),
                'price'        => $p->get_price(),
                'regular_price'=> $p->get_regular_price(),
                'sale_price'   => $p->get_sale_price(),
                'stock'        => $p->get_stock_quantity(),
                'stock_status' => $p->get_stock_status(),
                'type'         => $p->get_type(),
                'url'          => get_permalink( $p->get_id() ),
                'image'        => wp_get_attachment_url( $p->get_image_id() ),
                'description'  => wp_strip_all_tags( $p->get_description() ),
            ];
        }, $products );

        return new WP_REST_Response( $result, 200 );
    }

    public static function get_orders(): WP_REST_Response {
        $orders = wc_get_orders( [ 'limit' => 50, 'orderby' => 'date', 'order' => 'DESC' ] );
        $result = array_map( function( $o ) {
            return [
                'id'          => $o->get_id(),
                'status'      => $o->get_status(),
                'total'       => $o->get_total(),
                'currency'    => $o->get_currency(),
                'date'        => $o->get_date_created() ? $o->get_date_created()->date( 'Y-m-d H:i:s' ) : '',
                'customer_id' => $o->get_customer_id(),
                'items_count' => $o->get_item_count(),
                'email'       => $o->get_billing_email(),
            ];
        }, $orders );

        return new WP_REST_Response( $result, 200 );
    }

    public static function get_customers(): WP_REST_Response {
        $customers = get_users( [
            'role'   => 'customer',
            'number' => 50,
        ] );

        $result = array_map( function( $u ) {
            $orders = wc_get_orders( [ 'customer' => $u->ID, 'limit' => -1 ] );
            $total  = array_sum( array_map( fn( $o ) => (float) $o->get_total(), $orders ) );
            return [
                'id'           => $u->ID,
                'name'         => $u->display_name,
                'email'        => $u->user_email,
                'orders_count' => count( $orders ),
                'total_spent'  => $total,
            ];
        }, $customers );

        return new WP_REST_Response( $result, 200 );
    }

    public static function get_stats(): WP_REST_Response {
        // Quick sales summary for current month
        $start = date( 'Y-m-01' );
        $end   = date( 'Y-m-t' );

        $orders = wc_get_orders( [
            'status'     => [ 'completed', 'processing' ],
            'date_after' => $start,
            'date_before'=> $end,
            'limit'      => -1,
        ] );

        $revenue      = array_sum( array_map( fn( $o ) => (float) $o->get_total(), $orders ) );
        $refunds_raw  = array_sum( array_map( fn( $o ) => (float) $o->get_total_refunded(), $orders ) );

        return new WP_REST_Response( [
            'period'         => "$start to $end",
            'orders'         => count( $orders ),
            'revenue'        => round( $revenue, 2 ),
            'refunds'        => round( $refunds_raw, 2 ),
            'net_revenue'    => round( $revenue - $refunds_raw, 2 ),
            'currency'       => get_woocommerce_currency(),
        ], 200 );
    }

    public static function ai_description( WP_REST_Request $request ): WP_REST_Response {
        $prod_id = (int) $request['prod_id'];
        $product = wc_get_product( $prod_id );

        if ( ! $product ) {
            return new WP_REST_Response( [ 'error' => 'Product not found' ], 404 );
        }

        // Return product data for backend AI generation; also accept description to save
        $new_desc = $request->get_param( 'description' );
        if ( $new_desc ) {
            $product->set_description( wp_kses_post( $new_desc ) );
            $product->save();
            return new WP_REST_Response( [ 'success' => true, 'id' => $prod_id ], 200 );
        }

        return new WP_REST_Response( [
            'id'          => $prod_id,
            'name'        => $product->get_name(),
            'sku'         => $product->get_sku(),
            'price'       => $product->get_price(),
            'categories'  => wp_list_pluck( $product->get_category_ids(), null ),
            'attributes'  => $product->get_attributes(),
            'description' => $product->get_description(),
            'short_desc'  => $product->get_short_description(),
        ], 200 );
    }

    public static function bulk_ai_descriptions(): WP_REST_Response {
        $query    = new WC_Product_Query( [ 'limit' => 50, 'status' => 'publish', 'return' => 'objects' ] );
        $products = $query->get_products();

        $result = array_map( function( $p ) {
            return [
                'id'   => $p->get_id(),
                'name' => $p->get_name(),
                'desc' => $p->get_description(),
                'sku'  => $p->get_sku(),
            ];
        }, $products );

        return new WP_REST_Response( [
            'message'  => 'Product list returned for AI description generation. POST back to /woo/products/{id}/ai-description with description field to save.',
            'products' => $result,
        ], 200 );
    }

    public static function low_stock_alert(): WP_REST_Response {
        $threshold = (int) get_option( 'woocommerce_notify_low_stock_amount', 2 );

        $args = [
            'post_type'      => 'product',
            'posts_per_page' => -1,
            'meta_query'     => [
                [
                    'key'     => '_manage_stock',
                    'value'   => 'yes',
                ],
                [
                    'key'     => '_stock',
                    'value'   => $threshold,
                    'compare' => '<=',
                    'type'    => 'NUMERIC',
                ],
            ],
        ];

        $posts = get_posts( $args );
        $items = array_map( function( $p ) {
            $product = wc_get_product( $p->ID );
            return [
                'id'    => $p->ID,
                'name'  => $p->post_title,
                'sku'   => $product ? $product->get_sku() : '',
                'stock' => $product ? $product->get_stock_quantity() : 0,
            ];
        }, $posts );

        return new WP_REST_Response( [
            'threshold'   => $threshold,
            'low_stock'   => count( $items ),
            'products'    => $items,
        ], 200 );
    }
}
