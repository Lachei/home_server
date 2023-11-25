#include "database_util.hpp"

template <typename T>
static const std::string t = std::string(Database::column_type_name_v<T>);
using Date = Database::Date;
static Database::Table::ColumnInfos event_infos{
    .column_names = {"id"       , "title"       , "description" , "start_time", "end_time", "people"      , "visibility"  , "expected_hours", "progress"},
    .column_types = {t<uint64_t>, t<std::string>, t<std::string>, t<Date>     , t<Date>   , t<std::string>, t<std::string>, t<double>       , t<double>},
    .id_column = 0};
void setup_event_table(Database &database)
{
    assert(event_infos.column_names.size() == event_infos.column_types.size());
    database.create_table("event_table", event_infos);
}

nlohmann::json add_event(const nlohmann::json &event)
{
    // an event
    try
    {
    }
    catch (std::runtime_error e)
    {
    }
    catch (nlohmann::json::type_error e)
    {
    }
    return {};
}