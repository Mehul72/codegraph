package store

import (
	"database/sql"

	_ "github.com/lib/pq"

	"github.com/acme/app/internal/model"
)

// CountActiveQuery is kept out of line because the reports package reuses it.
const CountActiveQuery = `
SELECT count(*)
FROM users
JOIN sessions ON sessions.user_id = users.id
`

// DB owns the connection pool.
type DB struct {
	conn *sql.DB
}

// Open dials the database named by dsn.
func Open(dsn string) (*DB, error) {
	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	return &DB{conn: conn}, nil
}

// queryUser is the single row lookup behind Store.Get.
func (d *DB) queryUser(id string) (*model.User, error) {
	row := d.conn.QueryRow("SELECT id, name FROM users WHERE id = $1", id)
	var u model.User
	if err := row.Scan(&u.ID, &u.Name); err != nil {
		return nil, err
	}
	return &u, nil
}

// countActive reports how many users have an open session.
func (d *DB) countActive() (int, error) {
	var n int
	err := d.conn.QueryRow(CountActiveQuery).Scan(&n)
	return n, err
}
