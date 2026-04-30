<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Backups — Site backup endpoints.
 *
 * Creates a zip archive of the site's files + a MySQL dump.
 * Stores backup metadata in a WP option. Provides list/create/restore/delete/schedule.
 */
class WPMB_Backups {

    private static function backup_dir(): string {
        $upload_dir = wp_upload_dir();
        $dir        = $upload_dir['basedir'] . '/wpmb-backups';
        if ( ! is_dir( $dir ) ) {
            wp_mkdir_p( $dir );
            // Protect from direct access
            file_put_contents( $dir . '/.htaccess', 'deny from all' );
        }
        return $dir;
    }

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_admin' ];

        register_rest_route( $ns, '/backups', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'list_backups' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/backups/create', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'create_backup' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/backups/restore/(?P<backup_id>[\w-]+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'restore_backup' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/backups/(?P<backup_id>[\w-]+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'delete_backup' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/backups/schedule', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'schedule_backup' ],
            'permission_callback' => $ep,
        ] );

        // Download a backup file
        register_rest_route( $ns, '/backups/download/(?P<backup_id>[\w-]+)', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'download_backup' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function list_backups(): WP_REST_Response {
        $backups = get_option( 'wpmb_backups', [] );
        return new WP_REST_Response( array_values( $backups ), 200 );
    }

    public static function create_backup(): WP_REST_Response {
        if ( ! class_exists( 'ZipArchive' ) ) {
            return new WP_REST_Response( [ 'error' => 'ZipArchive PHP extension is required for backups' ], 501 );
        }

        $backup_dir = self::backup_dir();
        $id         = 'backup_' . date( 'Ymd_His' );
        $zip_path   = $backup_dir . '/' . $id . '.zip';

        $zip = new ZipArchive();
        if ( $zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE ) !== true ) {
            return new WP_REST_Response( [ 'error' => 'Cannot create backup archive' ], 500 );
        }

        // Add wp-content (excluding backups folder itself and cache)
        $wp_content = WP_CONTENT_DIR;
        $base_len   = strlen( ABSPATH ) - 1;
        $iterator   = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator( $wp_content, RecursiveDirectoryIterator::SKIP_DOTS ),
            RecursiveIteratorIterator::LEAVES_ONLY
        );

        foreach ( $iterator as $file ) {
            $real = $file->getRealPath();
            // Skip backup dir itself and cache
            if ( strpos( $real, $backup_dir ) !== false ) continue;
            if ( strpos( $real, '/cache/' ) !== false ) continue;
            $relative = substr( $real, $base_len );
            $zip->addFile( $real, $relative );
        }

        // Add DB dump as SQL string
        $sql = self::db_dump();
        $zip->addFromString( 'database.sql', $sql );

        $zip->close();

        $size = file_exists( $zip_path ) ? filesize( $zip_path ) : 0;

        $meta = [
            'id'         => $id,
            'filename'   => $id . '.zip',
            'size'       => $size,
            'created_at' => current_time( 'mysql' ),
        ];

        $backups       = get_option( 'wpmb_backups', [] );
        $backups[ $id ] = $meta;
        // Keep only last 10
        if ( count( $backups ) > 10 ) {
            array_shift( $backups );
        }
        update_option( 'wpmb_backups', $backups );

        return new WP_REST_Response( [ 'success' => true, 'backup' => $meta ], 201 );
    }

    public static function restore_backup( WP_REST_Request $request ): WP_REST_Response {
        $id      = sanitize_key( $request['backup_id'] );
        $backups = get_option( 'wpmb_backups', [] );

        if ( ! isset( $backups[ $id ] ) ) {
            return new WP_REST_Response( [ 'error' => 'Backup not found' ], 404 );
        }

        $zip_path = self::backup_dir() . '/' . $id . '.zip';
        if ( ! file_exists( $zip_path ) ) {
            return new WP_REST_Response( [ 'error' => 'Backup file missing on disk' ], 404 );
        }

        // NOTE: Full restore is destructive and should be confirmed by user.
        // We only restore the DB SQL here for safety.
        $zip = new ZipArchive();
        if ( $zip->open( $zip_path ) === true ) {
            $sql = $zip->getFromName( 'database.sql' );
            $zip->close();

            if ( $sql ) {
                global $wpdb;
                // Execute each statement
                $statements = array_filter( explode( ";\n", $sql ) );
                foreach ( $statements as $stmt ) {
                    $stmt = trim( $stmt );
                    if ( $stmt ) {
                        $wpdb->query( $stmt );
                    }
                }
                return new WP_REST_Response( [ 'success' => true, 'message' => 'Database restored from backup ' . $id ], 200 );
            }
        }

        return new WP_REST_Response( [ 'error' => 'Could not read backup archive' ], 500 );
    }

    public static function delete_backup( WP_REST_Request $request ): WP_REST_Response {
        $id      = sanitize_key( $request['backup_id'] );
        $backups = get_option( 'wpmb_backups', [] );

        if ( ! isset( $backups[ $id ] ) ) {
            return new WP_REST_Response( [ 'error' => 'Backup not found' ], 404 );
        }

        $zip_path = self::backup_dir() . '/' . $id . '.zip';
        if ( file_exists( $zip_path ) ) {
            unlink( $zip_path );
        }

        unset( $backups[ $id ] );
        update_option( 'wpmb_backups', $backups );

        return new WP_REST_Response( [ 'success' => true ], 200 );
    }

    public static function schedule_backup( WP_REST_Request $request ): WP_REST_Response {
        $frequency = sanitize_text_field( $request->get_param( 'frequency' ) ?? 'daily' );
        update_option( 'wpmb_backup_schedule', $frequency );

        // Clear existing scheduled event, re-register
        $hook = 'wpmb_scheduled_backup';
        $ts   = wp_next_scheduled( $hook );
        if ( $ts ) {
            wp_unschedule_event( $ts, $hook );
        }

        wp_schedule_event( time(), $frequency, $hook );

        return new WP_REST_Response( [ 'success' => true, 'frequency' => $frequency ], 200 );
    }

    public static function download_backup( WP_REST_Request $request ): void {
        $id       = sanitize_key( $request['backup_id'] );
        $zip_path = self::backup_dir() . '/' . $id . '.zip';

        if ( ! file_exists( $zip_path ) ) {
            wp_die( 'Backup not found', 404 );
        }

        header( 'Content-Type: application/zip' );
        header( 'Content-Disposition: attachment; filename="' . $id . '.zip"' );
        header( 'Content-Length: ' . filesize( $zip_path ) );
        readfile( $zip_path );
        exit;
    }

    /* -------------------------------------------------------
     *  DB dump helper (basic, no credentials needed — uses $wpdb)
     * ----------------------------------------------------- */
    private static function db_dump(): string {
        global $wpdb;
        $sql = '';

        $tables = $wpdb->get_results( 'SHOW TABLES', ARRAY_N );
        foreach ( $tables as $row ) {
            $table = $row[0];

            // Create table definition
            $create = $wpdb->get_row( "SHOW CREATE TABLE `$table`", ARRAY_N );
            if ( $create ) {
                $sql .= "\n\n" . $create[1] . ";\n\n";
            }

            // Data
            $rows = $wpdb->get_results( "SELECT * FROM `$table`", ARRAY_A );
            foreach ( $rows as $data_row ) {
                $values = array_map( function( $v ) use ( $wpdb ) {
                    return $v === null ? 'NULL' : "'" . esc_sql( $v ) . "'";
                }, $data_row );
                $sql .= "INSERT INTO `$table` VALUES (" . implode( ', ', $values ) . ");\n";
            }
        }

        return $sql;
    }
}

// Hook scheduled backup
add_action( 'wpmb_scheduled_backup', function() {
    WPMB_Backups::create_backup();
} );
