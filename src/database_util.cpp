#include "database_util.hpp"

template <typename T>
static const std::string t = std::string(Database::column_type_name_v<T>);
using Date = Database::Date;
static Database::Table::ColumnInfos event_infos{
    .column_names = {"id"       , "title"       , "description" , "start_time", "end_time", "creator"     , "people"      , "people_status", "visibility"  , "expected_hours", "progress"},
    .column_types = {t<uint64_t>, t<std::string>, t<std::string>, t<Date>     , t<Date>   , t<std::string>, t<std::string>, t<std::string> , t<std::string>, t<double>       , t<double>},
    .id_column = 0};
void setup_event_table(Database &database)
{
    assert(event_infos.column_names.size() == event_infos.column_types.size());
    database.create_table(event_table_name, event_infos);
}

nlohmann::json add_event(Database &db, const nlohmann::json &event)
{
    try
    {
        // getting all required parts of an event to create it
        const auto title = event["title"].get<std::string>();
        const auto description = event["description"].get<std::string>();
        const auto start_time = from_date_string(event["start_time"].get<std::string>());
        const auto end_time = from_date_string(event["end_time"].get<std::string>()); // time is always transmitted with a string
        const auto creator = event["creator"].get<std::string>();
        const auto people = std::string(json_array_remove_whitespace(event["people"].get<std::string>()));
        const auto visibility = event["visibility"].get<std::string>();
        const auto expected_hours = event["expected_hours"].get<float>();
        // no progress needed as it is assumed to be 0

        std::vector<Database::ElementType> new_event{title, description, start_time, end_time, creator, people, "[]", visibility, expected_hours, 0.0f};
        db.insert_row_without_id(event_table_name, new_event);
    }
    catch (std::runtime_error e)
    {
        return nlohmann::json{{"error", e.what()}};
    }
    catch (nlohmann::json::type_error e)
    {
        return nlohmann::json{{"error", std::string("Json missing parameter: "), e.what()}};
    }
    return {};
}

static nlohmann::json get_events(Database &db, std::string_view person)
{
    auto data = db.query_database(Database::EventQuery{.event_table_name = std::string(event_table_name),
                                                       .query_person = std::string(person)});
    const auto data_size = std::visit([](auto&& v){return v.size();}, data[0]);
    nlohmann::json res = std::vector<nlohmann::json>(data_size);
    for (auto i: i_range(data_size)) {
        res[i]["title"] = std::get<std::vector<std::string>>(data[1])[i];
        res[i]["description"] = std::get<std::vector<std::string>>(data[2])[i];
        res[i]["start_time"] = to_date_string(std::get<std::vector<Date>>(data[3])[i]);
        res[i]["end_time"] = to_date_string(std::get<std::vector<Date>>(data[4])[i]);
        res[i]["creator"] = std::get<std::vector<std::string>>(data[5])[i];
        res[i]["people"] = std::get<std::vector<std::string>>(data[6])[i];
        res[i]["people_status"] = std::get<std::vector<std::string>>(data[7])[i];
        res[i]["visibility"] = std::get<std::vector<std::string>>(data[8])[i];
        res[i]["expected_hours"] = std::get<std::vector<double>>(data[9])[i];
        res[i]["progress"] = std::get<std::vector<double>>(data[10])[i];
    }
    return res;
}
