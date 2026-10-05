-- Energy Star scores run 1-100. A weighted average outside that range means the floor-area
-- weighting is broken (e.g. a NULL area slipping into the denominator).
select lot_year_id, energy_star_score
from {{ ref('dim_lot_energy') }}
where energy_star_score < 1 or energy_star_score > 100
